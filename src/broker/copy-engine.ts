import { getPool } from "../db/pool.js";
import { config } from "../config.js";
import { getActiveSignals, type Signal } from "../signals/source.js";
import { applyAccess, getUserAccess } from "../access/access.js";
import { listCopyUsers, type CopySettings } from "./copy-settings.js";
import { toIntent, type BrokerAdapter, type OrderIntent } from "./adapter.js";

/* The copy engine — turns live signals into per-subscriber orders.
 *
 * Broker-agnostic by construction: it decides WHAT to trade and hands an
 * OrderIntent to a BrokerAdapter. Swapping ATAS for Tradovate changes the
 * adapter, never this file.
 *
 * Order of checks is deliberate and must not be reordered:
 *
 *   1. Master switch      — one env flag disables all execution everywhere
 *   2. ACCESS             — never trade a signal the user isn't entitled to SEE
 *   3. Copy filters       — market / conviction, their trading preferences
 *   4. Already handled?   — the idempotency gate
 *   5. Limits             — per-day and concurrent caps
 *   6. Broker ready?      — a skip, not a rejection
 *   7. Place / queue
 *
 * Access before preferences matters: a subscriber must not be able to widen
 * their entitlement by enabling copying on a market they don't pay for.
 *
 * SAFETY. Real money is at stake, so the engine is built to under-trade rather
 * than over-trade. Every uncertain path skips. Duplicate suppression is enforced
 * by a UNIQUE(userId, signalId) constraint in the DATABASE, not by logic here —
 * a race, a restart or two overlapping ticks cannot produce a second order. */

const TICK_MS = 5_000;
const DAY_MS = 86_400_000;

export type CopyStatus = "PLACED" | "QUEUED" | "PENDING_CONFIRM" | "REJECTED" | "SKIPPED";

export interface CopyDecision {
  userId: string;
  signalId: string;
  status: CopyStatus;
  reason?: string;
}

/** Signals the user may SEE — access is authoritative and applied first. */
async function visibleSignals(userId: string, signals: Signal[]): Promise<Signal[]> {
  const access = await getUserAccess(userId);
  // Locked signals are teasers (levels hidden); they must never be traded.
  return applyAccess(signals, access).filter((s) => !s.locked);
}

/** Does this signal match the user's own copy preferences? */
function matchesCopyFilters(signal: Signal, s: CopySettings): string | null {
  if (s.markets.length > 0 && !s.markets.includes(signal.market)) return "market not in copy list";
  if (signal.conviction < s.minConviction) return `conviction ${signal.conviction} below minimum ${s.minConviction}`;
  return null;
}

interface Usage {
  today: number;
  open: number;
}

/**
 * Orders already actioned for this user: how many in the last 24h, and how many
 * are still open. SKIPPED rows are excluded from both — a signal we declined is
 * not a trade and must not consume the user's budget.
 */
async function usageFor(userId: string): Promise<Usage> {
  const { rows } = await getPool().query(
    `SELECT
       count(*) FILTER (WHERE "createdAt" >= now() - interval '24 hours'
                          AND "status" <> 'SKIPPED')                       AS today,
       count(*) FILTER (WHERE "status" IN ('PLACED','QUEUED','PENDING_CONFIRM')) AS open
     FROM "signal"."CopyOrder" WHERE "userId" = $1`,
    [userId],
  );
  return { today: Number(rows[0]?.today ?? 0), open: Number(rows[0]?.open ?? 0) };
}

/**
 * Claim this (user, signal) pair, relying on the UNIQUE constraint.
 *
 * Inserting FIRST and letting the database reject a duplicate is what makes the
 * engine safe under concurrency: two ticks racing on the same signal cannot both
 * win, because the second insert violates the constraint. Checking-then-inserting
 * would leave a window between the two statements where both could pass.
 *
 * Returns the row id when claimed, or null when another tick already has it.
 */
async function claim(intent: OrderIntent, adapter: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `INSERT INTO "signal"."CopyOrder"
       ("userId","signalId","symbol","side","quantity","status","adapter",
        "stopLoss","takeProfit","conviction","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'PENDING_CONFIRM',$6,$7,$8,$9,now(),now())
     ON CONFLICT ("userId","signalId") DO NOTHING
     RETURNING "id"`,
    [
      intent.userId, intent.signalId, intent.symbol, intent.side, intent.quantity,
      adapter, intent.stopLoss, intent.takeProfit, intent.conviction,
    ],
  );
  return (rows[0]?.id as string | undefined) ?? null;
}

async function finalize(
  id: string,
  status: CopyStatus,
  brokerOrderId?: string | null,
  reason?: string,
): Promise<void> {
  await getPool().query(
    `UPDATE "signal"."CopyOrder"
     SET "status" = $2, "brokerOrderId" = $3, "reason" = $4, "updatedAt" = now()
     WHERE "id" = $1`,
    [id, status, brokerOrderId ?? null, reason ?? null],
  );
}

/** Record a signal we deliberately declined, so the UI can explain the gap. */
async function recordSkip(intent: OrderIntent, adapter: string, reason: string): Promise<void> {
  await getPool().query(
    `INSERT INTO "signal"."CopyOrder"
       ("userId","signalId","symbol","side","quantity","status","adapter","reason","conviction","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'SKIPPED',$6,$7,$8,now(),now())
     ON CONFLICT ("userId","signalId") DO NOTHING`,
    [intent.userId, intent.signalId, intent.symbol, intent.side, intent.quantity, adapter, reason, intent.conviction],
  );
}

/**
 * Evaluate every open signal for one subscriber.
 * Exported so tests can drive a single user deterministically.
 */
export async function processUser(
  userId: string,
  settings: CopySettings,
  signals: Signal[],
  adapter: BrokerAdapter,
): Promise<CopyDecision[]> {
  const out: CopyDecision[] = [];
  if (settings.mode === "off") return out;

  const visible = await visibleSignals(userId, signals);
  // Oldest first: if the daily cap bites, the user gets the signals that fired
  // first rather than an arbitrary subset.
  const candidates = visible.slice().sort((a, b) => a.openedAt - b.openedAt);

  let usage = await usageFor(userId);

  for (const signal of candidates) {
    const intent = toIntent(signal, userId, settings.quantity);

    const mismatch = matchesCopyFilters(signal, settings);
    if (mismatch) {
      // Not recorded: a market the user never intended to trade isn't a "skip"
      // worth surfacing, and recording it would consume the idempotency slot.
      out.push({ userId, signalId: signal.id, status: "SKIPPED", reason: mismatch });
      continue;
    }

    // Check caps BEFORE claiming, so a full budget doesn't burn the slot — the
    // signal stays eligible if a position closes later in the session.
    if (usage.today >= settings.maxPerDay) {
      out.push({ userId, signalId: signal.id, status: "SKIPPED", reason: "daily copy limit reached" });
      continue;
    }
    if (usage.open >= settings.maxConcurrent) {
      out.push({ userId, signalId: signal.id, status: "SKIPPED", reason: "max concurrent positions reached" });
      continue;
    }

    const id = await claim(intent, adapter.name);
    if (!id) continue; // already handled — the DB refused the duplicate

    // From here the slot is consumed either way, so every path must finalize.
    if (!(await adapter.isReady(userId))) {
      await finalize(id, "SKIPPED", null, "broker not connected");
      out.push({ userId, signalId: signal.id, status: "SKIPPED", reason: "broker not connected" });
      continue;
    }

    // 'confirm' stops here: prepared, awaiting the user's approval.
    if (settings.mode === "confirm") {
      usage = { today: usage.today + 1, open: usage.open + 1 };
      out.push({ userId, signalId: signal.id, status: "PENDING_CONFIRM" });
      continue;
    }

    try {
      const res = await adapter.placeOrder(intent);
      if (res.ok) {
        const status: CopyStatus = res.queued ? "QUEUED" : "PLACED";
        await finalize(id, status, res.brokerOrderId ?? null);
        usage = { today: usage.today + 1, open: usage.open + 1 };
        out.push({ userId, signalId: signal.id, status });
      } else {
        await finalize(id, "REJECTED", null, res.error ?? "broker rejected the order");
        out.push({ userId, signalId: signal.id, status: "REJECTED", reason: res.error });
      }
    } catch (err) {
      // An adapter that throws must not kill the tick for other users/signals.
      const msg = (err as Error).message;
      await finalize(id, "REJECTED", null, msg);
      out.push({ userId, signalId: signal.id, status: "REJECTED", reason: msg });
    }
  }

  return out;
}

/** One pass over every copy-enabled subscriber. Exported for tests. */
export async function runOnce(adapter: BrokerAdapter): Promise<CopyDecision[]> {
  if (!config.copyExecutionEnabled) return [];
  const [users, signals] = await Promise.all([listCopyUsers(), getActiveSignals()]);
  if (users.length === 0 || signals.length === 0) return [];

  // Demo signals must never reach a broker. They're synthesized for design work
  // and would place real orders against prices that were never quoted.
  const real = signals.filter((s) => !s.id.startsWith("demo-"));
  if (real.length === 0) return [];

  const out: CopyDecision[] = [];
  for (const { userId, settings } of users) {
    try {
      out.push(...(await processUser(userId, settings, real, adapter)));
    } catch (err) {
      console.warn(`[copy] user ${userId} failed:`, (err as Error).message);
    }
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function startCopyEngine(adapter: BrokerAdapter): void {
  if (timer) return;
  if (!config.copyExecutionEnabled) {
    console.log("[copy] execution disabled (set COPY_EXECUTION=1 to enable) — engine not started");
    return;
  }
  console.log(`[copy] engine started (adapter: ${adapter.name}, every ${TICK_MS / 1000}s)`);
  timer = setInterval(() => {
    if (ticking) return; // never let ticks overlap — that's how doubles happen
    ticking = true;
    void runOnce(adapter)
      .then((decisions) => {
        const acted = decisions.filter((d) => d.status !== "SKIPPED");
        if (acted.length > 0) console.log(`[copy] ${acted.length} order(s) actioned`);
      })
      .catch((err) => console.warn("[copy] tick failed:", (err as Error).message))
      .finally(() => { ticking = false; });
  }, TICK_MS);
}

export function stopCopyEngine(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export { DAY_MS };

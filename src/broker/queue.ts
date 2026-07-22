import { getPool } from "../db/pool.js";

/* The pull queue — what a subscriber's terminal (ATAS/NinjaTrader strategy)
 * collects and reports back on.
 *
 * The safety property here is AT-MOST-ONCE DELIVERY. If a strategy reconnects,
 * retries, or two copies run at once, the same order must never be handed out
 * twice — that would double-fill a live account. The claim is therefore an
 * atomic UPDATE ... RETURNING guarded by "claimedAt" IS NULL: whichever request
 * wins gets the rows, the loser gets nothing. Selecting and then updating would
 * leave a window where both could read the same row.
 *
 * We favour losing an order over duplicating one. A missed signal costs an
 * opportunity; a duplicate costs real money and breaks position sizing. */

export interface QueuedOrder {
  id: string;
  signalId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  stopLoss: number | null;
  takeProfit: number | null;
  conviction: number | null;
  createdAt: number;
}

/** Orders older than this are never delivered — see collect(). */
export const DEFAULT_MAX_AGE_MS = 5 * 60_000;

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Atomically claim this user's undelivered orders.
 *
 * `maxAgeMs` is a hard safety bound: a terminal that has been offline for hours
 * must NOT come back and fire a burst of stale entries into a market that has
 * long since moved. Anything older is marked EXPIRED instead of delivered.
 */
export async function collect(userId: string, maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<QueuedOrder[]> {
  const pool = getPool();

  // Retire stale work first, so it can never be part of the claim below.
  await pool.query(
    `UPDATE "signal"."CopyOrder"
     SET "status" = 'EXPIRED',
         "reason" = 'not collected in time — terminal offline',
         "updatedAt" = now()
     WHERE "userId" = $1 AND "status" = 'QUEUED' AND "claimedAt" IS NULL
       AND "createdAt" < now() - ($2 || ' milliseconds')::interval`,
    [userId, String(maxAgeMs)],
  );

  const { rows } = await pool.query(
    `UPDATE "signal"."CopyOrder"
     SET "claimedAt" = now(), "updatedAt" = now()
     WHERE "id" IN (
       SELECT "id" FROM "signal"."CopyOrder"
       WHERE "userId" = $1 AND "status" = 'QUEUED' AND "claimedAt" IS NULL
       ORDER BY "createdAt"
       FOR UPDATE SKIP LOCKED
     )
     RETURNING "id","signalId","symbol","side","quantity","stopLoss","takeProfit","conviction","createdAt"`,
    [userId],
  );

  return rows.map((r) => ({
    id: r.id as string,
    signalId: r.signalId as string,
    symbol: r.symbol as string,
    side: r.side as "LONG" | "SHORT",
    quantity: Number(r.quantity),
    stopLoss: num(r.stopLoss),
    takeProfit: num(r.takeProfit),
    conviction: num(r.conviction),
    createdAt: new Date(r.createdAt as string).getTime(),
  }));
}

/**
 * The terminal reports what happened. Scoped by userId so one subscriber can
 * never acknowledge another's order. Only claimed rows may be acked — an ack for
 * something never delivered indicates a bug or a forged id, and is rejected.
 */
export async function acknowledge(
  userId: string,
  orderId: string,
  outcome: { ok: boolean; brokerOrderId?: string | null; error?: string },
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE "signal"."CopyOrder"
     SET "status" = $3, "brokerOrderId" = $4, "reason" = $5, "updatedAt" = now()
     WHERE "id" = $1 AND "userId" = $2 AND "claimedAt" IS NOT NULL AND "status" = 'QUEUED'`,
    [
      orderId,
      userId,
      outcome.ok ? "PLACED" : "REJECTED",
      outcome.brokerOrderId ?? null,
      outcome.ok ? null : (outcome.error ?? "terminal reported failure").slice(0, 500),
    ],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Release orders claimed but never acknowledged (terminal crashed mid-place).
 *
 * Deliberately marks them ABANDONED rather than re-queueing: we cannot know
 * whether the broker received the order before the crash, so re-sending risks a
 * duplicate fill. A human decides. Same principle as everywhere else here —
 * under-trade rather than over-trade.
 */
export async function reapAbandoned(staleMs = 60_000): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE "signal"."CopyOrder"
     SET "status" = 'ABANDONED',
         "reason" = 'collected but never confirmed — outcome unknown',
         "updatedAt" = now()
     WHERE "status" = 'QUEUED' AND "claimedAt" IS NOT NULL
       AND "claimedAt" < now() - ($1 || ' milliseconds')::interval`,
    [String(staleMs)],
  );
  return rowCount ?? 0;
}

/** Recent copy activity for the Automation page. */
export async function recentOrders(userId: string, limit = 50): Promise<Record<string, unknown>[]> {
  const { rows } = await getPool().query(
    `SELECT "id","signalId","symbol","side","quantity","status","reason","brokerOrderId",
            "stopLoss","takeProfit","conviction","createdAt","updatedAt"
     FROM "signal"."CopyOrder"
     WHERE "userId" = $1
     ORDER BY "createdAt" DESC
     LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    ...r,
    quantity: Number(r.quantity),
    stopLoss: num(r.stopLoss),
    takeProfit: num(r.takeProfit),
    conviction: num(r.conviction),
    createdAt: new Date(r.createdAt as string).getTime(),
    updatedAt: new Date(r.updatedAt as string).getTime(),
  }));
}

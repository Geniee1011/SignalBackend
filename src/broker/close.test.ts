/* Close-mirroring tests: when the trader exits, subscribers must exit too.
 * Run: npx tsx src/broker/close.test.ts */

import { getPool } from "../db/pool.js";
import { processUser, queueCloses } from "./copy-engine.js";
import { PullAdapter } from "./adapters/pull.js";
import { collect, acknowledge } from "./queue.js";
import { DEFAULT_COPY, type CopySettings } from "./copy-settings.js";
import type { Signal } from "../signals/source.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const signal = (id: string, over: Partial<Signal> = {}): Signal => ({
  id, symbol: "ES", market: "ES", side: "SHORT",
  entry: 7530, stopLoss: 7540, takeProfit: 7520, exit: null,
  quantity: 1, conviction: 2, status: "active",
  openedAt: Date.now() - 60_000, closedAt: null,
  pnl: null, unrealizedPnl: 0, win: null,
  ...over,
});

const settings = (over: Partial<CopySettings> = {}): CopySettings => ({ ...DEFAULT_COPY, mode: "auto", ...over });

/** Sweep with the given signal ids still open (default: none — trader went flat). */
const sweepCloses = (stillOpen: string[] = []) => queueCloses(new Set(stillOpen), "atas");

async function main(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO "signal"."User" ("email","passwordHash","name","role","status")
     VALUES ($1,'x','Close Test','SUBSCRIBER','ACTIVE') RETURNING "id"`,
    [`close-test-${Date.now()}@example.com`],
  );
  const userId = rows[0].id as string;
  const adapter = new PullAdapter("atas");
  const clear = () => pool.query(`DELETE FROM "signal"."CopyOrder" WHERE "userId" = $1`, [userId]);
  const ordersFor = async (kind: string) =>
    (await pool.query(
      `SELECT "id","side","quantity","status","symbol" FROM "signal"."CopyOrder"
       WHERE "userId" = $1 AND "kind" = $2 ORDER BY "createdAt"`, [userId, kind])).rows;

  try {
    console.log("\nclose mirroring\n");

    // --- the core behaviour ------------------------------------------------
    {
      await clear();
      const sig = signal("lot:close-1");
      await processUser(userId, settings(), [sig], adapter);
      check("entry queued", (await ordersFor("ENTRY")).length === 1);

      // The signal vanishes from the active set = the trader closed.
      await sweepCloses();
      const closes = await ordersFor("CLOSE");
      check("close queued when the signal disappears", closes.length === 1, `got ${closes.length}`);
      check("close carries the ENTRY's side (to flatten, not reverse)", closes[0]?.side === "SHORT", closes[0]?.side);
      // The close mirrors the ENTRY's risk-sized values: conviction 2 → $200, a 10pt
      // stop on MES ($5/pt) = $50/contract → 4 micros of MES.
      check("close carries the entry's sized quantity", Number(closes[0]?.quantity) === 4, `${closes[0]?.quantity}`);
      check("close carries the entry's micro symbol", closes[0]?.symbol === "MES", closes[0]?.symbol);
    }

    // --- idempotency: the sweep runs every tick -----------------------------
    {
      await clear();
      await processUser(userId, settings(), [signal("lot:close-2")], adapter);
      await sweepCloses();
      await sweepCloses();
      await sweepCloses();
      check("repeated sweeps queue exactly ONE close", (await ordersFor("CLOSE")).length === 1);
    }

    // --- must NOT close while still open ------------------------------------
    {
      await clear();
      await processUser(userId, settings(), [signal("lot:still-open")], adapter);
      // Sweep while that signal IS still in the open set — the trader hasn't exited.
      await sweepCloses(["lot:still-open"]);
      check("no close while the signal is still open", (await ordersFor("CLOSE")).length === 0);
      // Now it disappears.
      await sweepCloses([]);
      check("closes once the signal ends", (await ordersFor("CLOSE")).length === 1);
    }

    // --- one subscriber's exit must not close another's position ------------
    {
      await clear();
      await processUser(userId, settings(), [signal("lot:multi-a"), signal("lot:multi-b")], adapter);
      await sweepCloses(["lot:multi-b"]); // only A closed upstream
      const closes = await ordersFor("CLOSE");
      check("closes only the signal that ended", closes.length === 1, `got ${closes.length}`);
    }

    // --- a closed position frees a concurrent slot -------------------------
    // Regression: `open` counted every placed entry forever, so once an account
    // reached maxConcurrent it jammed permanently — new signals were skipped even
    // after their positions had long since closed. An entry with a CLOSE must stop
    // occupying a slot.
    {
      await clear();
      const cap = settings({ maxConcurrent: 2 });
      await processUser(userId, cap, [signal("lot:cap-a"), signal("lot:cap-b")], adapter);
      check("two entries fill the cap of 2", (await ordersFor("ENTRY")).length === 2);

      const atCap = await processUser(userId, cap, [signal("lot:cap-c")], adapter);
      check("a third signal is refused at the cap",
        atCap.find((d) => d.signalId === "lot:cap-c")?.status === "SKIPPED",
        atCap.find((d) => d.signalId === "lot:cap-c")?.reason);

      // cap-a's position ends (it leaves the open set); cap-b stays open.
      await sweepCloses(["lot:cap-b"]);
      check("close queued for the ended position", (await ordersFor("CLOSE")).length === 1);

      const freed = await processUser(userId, cap, [signal("lot:cap-c")], adapter);
      check("the freed slot now admits the third signal",
        freed.find((d) => d.signalId === "lot:cap-c")?.status === "QUEUED",
        freed.find((d) => d.signalId === "lot:cap-c")?.status);
    }

    // --- a CLOSE does not eat into the daily budget ------------------------
    // Only entries are "copied signals". With maxPerDay=2 and one entry + its
    // close, a second entry must still fit — the old accounting counted the close
    // as a second signal and would wrongly refuse it (so this distinguishes the
    // fix from the bug, not just documents intent).
    {
      await clear();
      const cap = settings({ maxPerDay: 2 });
      await processUser(userId, cap, [signal("lot:budget-1")], adapter);
      await sweepCloses(); // ends it → a CLOSE row joins the entry
      const after = await processUser(userId, cap, [signal("lot:budget-2")], adapter);
      check("a CLOSE does not consume the daily entry budget",
        after.find((d) => d.signalId === "lot:budget-2")?.status === "QUEUED",
        after.find((d) => d.signalId === "lot:budget-2")?.status);
    }

    // --- entries that never reached a broker must not be closed -------------
    {
      await clear();
      await processUser(userId, settings(), [signal("lot:rejected-1")], adapter);
      await pool.query(
        `UPDATE "signal"."CopyOrder" SET "status" = 'REJECTED' WHERE "userId" = $1 AND "kind" = 'ENTRY'`,
        [userId],
      );
      await sweepCloses();
      check("a REJECTED entry is never closed", (await ordersFor("CLOSE")).length === 0);
    }
    {
      await clear();
      await processUser(userId, settings(), [signal("lot:skipped-1")], adapter);
      await pool.query(
        `UPDATE "signal"."CopyOrder" SET "status" = 'SKIPPED' WHERE "userId" = $1 AND "kind" = 'ENTRY'`,
        [userId],
      );
      await sweepCloses();
      check("a SKIPPED entry is never closed", (await ordersFor("CLOSE")).length === 0);
    }

    // --- delivery ------------------------------------------------------------
    {
      await clear();
      await processUser(userId, settings(), [signal("lot:deliver-1")], adapter);
      await collect(userId);                      // terminal takes the entry
      await sweepCloses();
      const got = await collect(userId);          // terminal takes the close
      check("close is delivered to the terminal", got.length === 1, `got ${got.length}`);
      check("delivered with kind=CLOSE", got[0]?.kind === "CLOSE", got[0]?.kind);
    }

    // --- a close must never expire ------------------------------------------
    {
      await clear();
      await processUser(userId, settings(), [signal("lot:stale-close")], adapter);
      await collect(userId);
      await sweepCloses();
      await pool.query(
        `UPDATE "signal"."CopyOrder" SET "createdAt" = now() - interval '2 hours'
         WHERE "userId" = $1 AND "kind" = 'CLOSE'`, [userId],
      );
      const got = await collect(userId, 5 * 60_000); // well past the entry staleness bound
      check("a stale CLOSE is still delivered (never stranded)", got.length === 1 && got[0]?.kind === "CLOSE",
            `got ${got.length}`);
    }

    // --- LOG-ONLY must rehearse the FULL lifecycle ---------------------------
    // Regression: closes originally required PLACED/QUEUED, so a dry-run entry
    // never produced a close. That made log-only mode able to test entries but
    // never exits — the exact bug you'd want a dry run to catch.
    {
      await clear();
      await processUser(userId, settings(), [signal("lot:dry-1")], adapter);
      const [q] = await collect(userId);
      await acknowledge(userId, q!.id, { ok: false, dryRun: true, error: "log-only mode" });
      const entry = (await ordersFor("ENTRY"))[0];
      check("log-only ack records DRY_RUN", entry?.status === "DRY_RUN", entry?.status);

      await sweepCloses([]);
      check("a DRY_RUN entry still produces a CLOSE", (await ordersFor("CLOSE")).length === 1);
    }

    // A genuine skip (filter/limit/already-flat) must still NOT be closed.
    {
      await clear();
      await processUser(userId, settings(), [signal("lot:skip-2")], adapter);
      const [q] = await collect(userId);
      await acknowledge(userId, q!.id, { ok: false, skipped: true, error: "already flat" });
      await sweepCloses([]);
      check("a genuinely SKIPPED entry is still never closed", (await ordersFor("CLOSE")).length === 0);
    }

    // --- skipped ack is distinct from rejected ------------------------------
    {
      await clear();
      await processUser(userId, settings(), [signal("lot:ack-skip")], adapter);
      const [o] = await collect(userId);
      await acknowledge(userId, o!.id, { ok: false, skipped: true, error: "log-only mode" });
      const row = (await ordersFor("ENTRY"))[0];
      check("log-only ack records SKIPPED, not REJECTED", row?.status === "SKIPPED", row?.status);
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
  } finally {
    await pool.query(`DELETE FROM "signal"."User" WHERE "id" = $1`, [userId]);
    await pool.end();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

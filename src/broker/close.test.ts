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
      check("close carries the same quantity", Number(closes[0]?.quantity) === 1);
      check("close carries the same symbol", closes[0]?.symbol === "ES");
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

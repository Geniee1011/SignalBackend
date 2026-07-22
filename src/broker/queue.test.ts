/* Pull-queue tests: at-most-once delivery, staleness, and ack scoping.
 * Run: npx tsx src/broker/queue.test.ts */

import { getPool } from "../db/pool.js";
import { processUser } from "./copy-engine.js";
import { PullAdapter } from "./adapters/pull.js";
import { collect, acknowledge, reapAbandoned } from "./queue.js";
import { DEFAULT_COPY, type CopySettings } from "./copy-settings.js";
import type { Signal } from "../signals/source.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const signal = (over: Partial<Signal> = {}): Signal => ({
  id: `q-sig-${Math.round(Math.random() * 1e9)}`,
  symbol: "NQ", market: "NQ", side: "LONG",
  entry: 28900, stopLoss: 28850, takeProfit: 29000, exit: null,
  quantity: 1, conviction: 3, status: "active",
  openedAt: Date.now() - 30_000, closedAt: null,
  pnl: null, unrealizedPnl: 0, win: null,
  ...over,
});

const settings = (over: Partial<CopySettings> = {}): CopySettings => ({ ...DEFAULT_COPY, mode: "auto", ...over });

async function mkUser(pool: ReturnType<typeof getPool>, tag: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO "signal"."User" ("email","passwordHash","name","role","status")
     VALUES ($1,'x','Queue Test','SUBSCRIBER','ACTIVE') RETURNING "id"`,
    [`queue-${tag}-${Date.now()}@example.com`],
  );
  return rows[0].id as string;
}

async function main(): Promise<void> {
  const pool = getPool();
  const userId = await mkUser(pool, "a");
  const otherId = await mkUser(pool, "b");
  const adapter = new PullAdapter();
  const clear = () => pool.query(`DELETE FROM "signal"."CopyOrder" WHERE "userId" = ANY($1)`, [[userId, otherId]]);

  try {
    console.log("\npull queue\n");

    // --- at-most-once delivery: the property that prevents double fills ----
    {
      await clear();
      await processUser(userId, settings(), [signal()], adapter);
      const first = await collect(userId);
      const second = await collect(userId);
      check("queued order is delivered once", first.length === 1, `got ${first.length}`);
      check("a second collect returns nothing", second.length === 0, `got ${second.length}`);
    }
    {
      await clear();
      await processUser(userId, settings(), [signal()], adapter);
      // Two strategy instances (or a retry) racing for the same queue.
      const [a, b, c] = await Promise.all([collect(userId), collect(userId), collect(userId)]);
      const total = a.length + b.length + c.length;
      check("concurrent collects deliver exactly once", total === 1, `delivered ${total}x`);
    }

    // --- the order handed to the terminal ---------------------------------
    {
      await clear();
      await processUser(userId, settings({ quantity: 3 }), [signal({ side: "LONG", stopLoss: 28850, takeProfit: 29000 })], adapter);
      const [o] = await collect(userId);
      check("carries side/qty/levels", o?.side === "LONG" && o?.quantity === 3 && o?.stopLoss === 28850 && o?.takeProfit === 29000);
      check("carries the signal id for tracing", typeof o?.signalId === "string" && o.signalId.length > 0);
    }

    // --- acknowledgement ---------------------------------------------------
    {
      await clear();
      await processUser(userId, settings(), [signal()], adapter);
      const [o] = await collect(userId);
      const ok = await acknowledge(userId, o!.id, { ok: true, brokerOrderId: "NT-123" });
      const twice = await acknowledge(userId, o!.id, { ok: true, brokerOrderId: "NT-123" });
      check("ack marks the order placed", ok);
      check("double-ack is refused", !twice);
      const { rows } = await pool.query(`SELECT "status","brokerOrderId" FROM "signal"."CopyOrder" WHERE "id"=$1`, [o!.id]);
      check("status is PLACED with broker id", rows[0]?.status === "PLACED" && rows[0]?.brokerOrderId === "NT-123");
    }
    {
      await clear();
      await processUser(userId, settings(), [signal()], adapter);
      const [o] = await collect(userId);
      await acknowledge(userId, o!.id, { ok: false, error: "margin rejected" });
      const { rows } = await pool.query(`SELECT "status","reason" FROM "signal"."CopyOrder" WHERE "id"=$1`, [o!.id]);
      check("failed ack records the reason", rows[0]?.status === "REJECTED" && rows[0]?.reason === "margin rejected");
    }
    {
      await clear();
      await processUser(userId, settings(), [signal()], adapter);
      const [o] = await collect(userId);
      const stolen = await acknowledge(otherId, o!.id, { ok: true });
      check("another user cannot ack your order", !stolen);
    }
    {
      await clear();
      await processUser(userId, settings(), [signal()], adapter);
      // Never collected → nothing to acknowledge.
      const { rows } = await pool.query(`SELECT "id" FROM "signal"."CopyOrder" WHERE "userId"=$1`, [userId]);
      const early = await acknowledge(userId, rows[0].id as string, { ok: true });
      check("cannot ack an uncollected order", !early);
    }

    // --- staleness: an offline terminal must not fire old entries ----------
    {
      await clear();
      await processUser(userId, settings(), [signal()], adapter);
      await pool.query(
        `UPDATE "signal"."CopyOrder" SET "createdAt" = now() - interval '30 minutes' WHERE "userId"=$1`,
        [userId],
      );
      const got = await collect(userId, 5 * 60_000);
      const { rows } = await pool.query(`SELECT "status" FROM "signal"."CopyOrder" WHERE "userId"=$1`, [userId]);
      check("stale orders are not delivered", got.length === 0, `got ${got.length}`);
      check("stale orders are marked EXPIRED", rows[0]?.status === "EXPIRED", rows[0]?.status);
    }

    // --- crash recovery ----------------------------------------------------
    {
      await clear();
      await processUser(userId, settings(), [signal()], adapter);
      const [o] = await collect(userId);
      await pool.query(`UPDATE "signal"."CopyOrder" SET "claimedAt" = now() - interval '10 minutes' WHERE "id"=$1`, [o!.id]);
      const n = await reapAbandoned(60_000);
      const { rows } = await pool.query(`SELECT "status" FROM "signal"."CopyOrder" WHERE "id"=$1`, [o!.id]);
      check("unconfirmed orders are reaped", n >= 1);
      check("reaped as ABANDONED, never re-queued", rows[0]?.status === "ABANDONED", rows[0]?.status);
    }

    // --- isolation ---------------------------------------------------------
    {
      await clear();
      await processUser(userId, settings(), [signal()], adapter);
      const theirs = await collect(otherId);
      check("users only collect their own orders", theirs.length === 0, `got ${theirs.length}`);
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
  } finally {
    await pool.query(`DELETE FROM "signal"."User" WHERE "id" = ANY($1)`, [[userId, otherId]]);
    await pool.end();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

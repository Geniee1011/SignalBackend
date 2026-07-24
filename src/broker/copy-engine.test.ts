/* End-to-end test for the copy engine against a real database and a mock broker.
 *
 * Run: npx tsx src/broker/copy-engine.test.ts
 *
 * Uses a throwaway subscriber, and removes it (cascading to their CopyOrder rows)
 * in a finally block so a failed assertion can't leave test data behind. */

import { getPool } from "../db/pool.js";
import { processUser } from "./copy-engine.js";
import { MockAdapter } from "./adapters/mock.js";
import { DEFAULT_COPY, type CopySettings } from "./copy-settings.js";
import type { Signal } from "../signals/source.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: `test-sig-${Math.round(Math.random() * 1e9)}`,
    symbol: "ES", market: "ES", side: "SHORT",
    entry: 7500, stopLoss: 7520, takeProfit: 7460, exit: null,
    quantity: 1, conviction: 3, status: "active",
    openedAt: Date.now() - 60_000, closedAt: null,
    pnl: null, unrealizedPnl: 125, win: null,
    ...over,
  };
}

const settings = (over: Partial<CopySettings> = {}): CopySettings => ({ ...DEFAULT_COPY, mode: "auto", ...over });

async function main(): Promise<void> {
  const pool = getPool();
  const email = `copy-test-${Date.now()}@example.com`;
  const { rows } = await pool.query(
    `INSERT INTO "signal"."User" ("email","passwordHash","name","role","status")
     VALUES ($1,'x','Copy Test','SUBSCRIBER','ACTIVE') RETURNING "id"`,
    [email],
  );
  const userId = rows[0].id as string;
  const clear = () => pool.query(`DELETE FROM "signal"."CopyOrder" WHERE "userId" = $1`, [userId]);

  try {
    console.log("\ncopy engine\n");

    // --- the core safety property -----------------------------------------
    {
      await clear();
      const s = signal();
      const a = new MockAdapter();
      const first = await processUser(userId, settings(), [s], a);
      const second = await processUser(userId, settings(), [s], a);
      check("places an eligible signal", first[0]?.status === "PLACED", first[0]?.reason);
      check("NEVER places the same signal twice", a.placed.length === 1, `placed ${a.placed.length}x`);
      check("second pass is a no-op", second.length === 0);
    }

    // Concurrency: the DB constraint, not application logic, must hold the line.
    {
      await clear();
      const s = signal();
      const a = new MockAdapter();
      await Promise.all([
        processUser(userId, settings(), [s], a),
        processUser(userId, settings(), [s], a),
        processUser(userId, settings(), [s], a),
      ]);
      check("concurrent ticks cannot double-place", a.placed.length === 1, `placed ${a.placed.length}x`);
    }

    // --- the inverted order reaching the broker ---------------------------
    {
      await clear();
      const a = new MockAdapter();
      await processUser(userId, settings({ quantity: 2 }), [signal({ side: "SHORT", stopLoss: 7520, takeProfit: 7460 })], a);
      const o = a.placed[0];
      check("side is the signal's counter side", o?.side === "SHORT");
      // Risk sizing supersedes the flat `quantity`: conviction 3 → $300 target, a
      // 20pt stop on MES ($5/pt) = $100/contract → 3 micros. The `quantity: 2` is ignored.
      check("quantity is risk-sized, not the flat setting", o?.quantity === 3, `got ${o?.quantity}`);
      check("stop/target carried through", o?.stopLoss === 7520 && o?.takeProfit === 7460);
      check("symbol is the micro contract", o?.symbol === "MES", o?.symbol);
    }

    // --- filters -----------------------------------------------------------
    {
      await clear();
      const a = new MockAdapter();
      const out = await processUser(userId, settings({ markets: ["NQ"] }), [signal({ market: "ES" })], a);
      check("market filter blocks", out[0]?.status === "SKIPPED" && a.placed.length === 0);
    }
    {
      await clear();
      const a = new MockAdapter();
      const out = await processUser(userId, settings({ minConviction: 4 }), [signal({ conviction: 2 })], a);
      check("conviction filter blocks", out[0]?.status === "SKIPPED" && a.placed.length === 0);
    }
    {
      await clear();
      const a = new MockAdapter();
      const out = await processUser(userId, settings({ mode: "off" }), [signal()], a);
      check("mode=off does nothing", out.length === 0 && a.placed.length === 0);
    }

    // --- limits ------------------------------------------------------------
    {
      await clear();
      const a = new MockAdapter();
      const many = [signal(), signal(), signal(), signal(), signal()];
      const out = await processUser(userId, settings({ maxPerDay: 2, maxConcurrent: 99 }), many, a);
      check("daily cap enforced", a.placed.length === 2, `placed ${a.placed.length}`);
      check("excess reported as skipped", out.filter((d) => d.status === "SKIPPED").length === 3);
    }
    {
      await clear();
      const a = new MockAdapter();
      const out = await processUser(userId, settings({ maxConcurrent: 1, maxPerDay: 99 }), [signal(), signal(), signal()], a);
      check("concurrent cap enforced", a.placed.length === 1, `placed ${a.placed.length}`);
      check("cap reason surfaced", out.some((d) => d.reason?.includes("concurrent")));
    }

    // --- failure handling --------------------------------------------------
    {
      await clear();
      const a = new MockAdapter({ ready: false });
      const out = await processUser(userId, settings(), [signal()], a);
      check("disconnected broker skips (not rejects)", out[0]?.status === "SKIPPED", out[0]?.status);
    }
    {
      await clear();
      const a = new MockAdapter({ reject: "insufficient margin" });
      const out = await processUser(userId, settings(), [signal()], a);
      check("broker rejection recorded", out[0]?.status === "REJECTED" && out[0]?.reason === "insufficient margin");
    }
    {
      await clear();
      const a = new MockAdapter({ throws: true });
      const out = await processUser(userId, settings(), [signal()], a);
      check("adapter exception doesn't crash the tick", out[0]?.status === "REJECTED");
    }
    {
      await clear();
      const a = new MockAdapter({ queued: true });
      const out = await processUser(userId, settings(), [signal()], a);
      check("pull-mode reports QUEUED", out[0]?.status === "QUEUED", out[0]?.status);
    }

    // --- confirm mode ------------------------------------------------------
    {
      await clear();
      const a = new MockAdapter();
      const out = await processUser(userId, settings({ mode: "confirm" }), [signal()], a);
      check("confirm mode prepares but does NOT place", out[0]?.status === "PENDING_CONFIRM" && a.placed.length === 0);
    }

    // A skipped signal must not consume the user's daily budget.
    {
      await clear();
      const a = new MockAdapter();
      await processUser(userId, settings({ markets: ["NQ"] }), [signal({ market: "ES" })], a);
      const out = await processUser(userId, settings({ maxPerDay: 1 }), [signal()], a);
      check("skips don't consume the daily budget", out[0]?.status === "PLACED", out[0]?.reason);
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
  } finally {
    await pool.query(`DELETE FROM "signal"."User" WHERE "id" = $1`, [userId]);
    await pool.end();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

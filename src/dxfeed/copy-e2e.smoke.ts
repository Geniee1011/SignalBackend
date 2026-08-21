/* B13 — the LAST integration: copy engine -> dxFeed, end to end.
 *
 * Run: npx tsx src/dxfeed/copy-e2e.smoke.ts --confirm
 *
 * PLACES A REAL ORDER on staging, hence --confirm. Everything before this tested
 * one layer at a time: order.smoke drives the WSS client directly, and the offline
 * suites drive the engine against fakes. Nothing has yet run a SIGNAL through
 * access -> allocation -> risk sizing -> DxFeedAdapter -> the live broker, which
 * is the path that actually runs in production.
 *
 * SAFETY — the entry cannot fill. It is a LONG limit priced far BELOW the market,
 * so it rests in the book; the close sweep then flattens it with FLAT_CANCEL,
 * which cancels a resting order as readily as it closes a filled one. That is the
 * same code path a real close takes, so nothing is skipped by staying unfilled.
 *
 * The test seeds its own subscriber and links them to a staging dxFeed account,
 * then removes both. It never touches a real subscriber's row.
 */

import { getPool } from "../db/pool.js";
import { dxfeedTradingReady } from "../config.js";
import { processUser, queueCloses } from "../broker/copy-engine.js";
import { DEFAULT_COPY, type CopySettings } from "../broker/copy-settings.js";
import type { Signal } from "../signals/source.js";
import { DxFeedTradingClient } from "./trading-ws.js";
import { DxFeedAdapter } from "./adapter.js";
import { setTradingClient } from "./trading-client.js";
import { upsertDxFeedLink, deleteDxFeedLink } from "./store.js";
import { AccountStatus } from "./types.js";
import { loadSchema } from "./proto/codec.js";

/** Well below any MES level, so the resting entry cannot fill. */
const ENTRY = 7000, STOP = 6990, TARGET = 7020;
const LOGIN_TIMEOUT_MS = 30_000;

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const signal = (id: string): Signal => ({
  id, symbol: "ES", market: "ES", side: "LONG",
  entry: ENTRY, stopLoss: STOP, takeProfit: TARGET, exit: null,
  quantity: 1, conviction: 1, status: "active",
  openedAt: Date.now() - 60_000, closedAt: null,
  pnl: null, unrealizedPnl: 0, win: null,
});

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm")) {
    console.error("\nRefusing to run: this places a REAL order on dxFeed staging.\n  Re-run with --confirm.\n");
    process.exit(2);
  }
  if (!dxfeedTradingReady) { console.error("trading credentials are not set"); process.exit(1); }

  console.log("\ncopy engine -> dxFeed, end to end (staging)\n");
  await loadSchema();

  const pool = getPool();
  const client = new DxFeedTradingClient();
  setTradingClient(client);
  const adapter = new DxFeedAdapter();
  let userId = "";
  let accountRef = "";

  try {
    await client.start();
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (!client.isConnected() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    if (!client.isConnected()) throw new Error("no login — sessions may be exhausted");
    await new Promise((r) => setTimeout(r, 3_000));

    const target = process.argv.find((a) => a.startsWith("--account="))?.split("=")[1]?.replace(/\D/g, "");
    const accounts = client.knownAccounts();
    const picked = target ? accounts.find(([, n]) => String(n) === target) : accounts[0];
    if (!picked) throw new Error("no usable dxFeed account on this session");
    accountRef = picked[0];
    const blocked = client.blockedReason(accountRef);
    if (blocked) throw new Error(`account ${picked[1]} cannot trade: ${blocked}`);
    console.log(`  dxFeed account : ${accountRef} (#${picked[1]})\n`);

    // --- seed a subscriber linked to that account --------------------------
    const { rows } = await pool.query(
      `INSERT INTO "signal"."User" ("email","passwordHash","name","role","status")
       VALUES ($1,'x','dxFeed E2E','SUBSCRIBER','ACTIVE') RETURNING "id"`,
      [`dxfeed-e2e-${Date.now()}@example.com`],
    );
    userId = rows[0].id as string;
    await upsertDxFeedLink({
      userId, dxUserId: `e2e-${userId}`, dxAccountId: accountRef, dxSubscriptionId: null,
      accountStatus: AccountStatus.ENABLED, subscriptionStatus: null,
      agreementSigned: true, agreementLink: null, platform: null,
    });

    check("adapter reports the subscriber ready", await adapter.isReady(userId));

    // --- ENTRY: signal -> sizing -> adapter -> live broker ------------------
    // baseRisk is set low so this sizes to a small number of micros; the point is
    // the path, not the size.
    const settings: CopySettings = { ...DEFAULT_COPY, mode: "auto", baseRisk: 50 };
    const sig = signal(`e2e-${Date.now()}`);
    const decisions = await processUser(userId, settings, [sig], adapter, 50);
    const d = decisions.find((x) => x.signalId === sig.id);
    console.log(`  engine decision: ${d?.status}${d?.reason ? ` (${d.reason})` : ""}`);

    const entry = (await pool.query(
      `SELECT "status","brokerOrderId","symbol","quantity","reason" FROM "signal"."CopyOrder"
       WHERE "userId" = $1 AND "kind" = 'ENTRY'`, [userId])).rows[0];
    check("an ENTRY row was written", !!entry);
    console.log(`  entry row: ${entry?.symbol} x${entry?.quantity} -> ${entry?.status} ` +
      `brokerOrderId=${entry?.brokerOrderId ?? "-"}${entry?.reason ? ` reason=${entry.reason}` : ""}`);
    check("the entry reached dxFeed and was PLACED", entry?.status === "PLACED", entry?.status);
    check("dxFeed returned a broker order id", !!entry?.brokerOrderId);
    check("sized into the MICRO contract", entry?.symbol === "MES", entry?.symbol);

    // --- CLOSE: the sweep must SEND it, not just queue it ------------------
    // Empty open-set = the trader went flat, so everything open should close.
    const closes = await queueCloses(new Set(), adapter);
    console.log(`  close decisions: ${JSON.stringify(closes.map((c) => `${c.status}:${c.reason ?? ""}`))}`);

    const close = (await pool.query(
      `SELECT "status","reason" FROM "signal"."CopyOrder" WHERE "userId" = $1 AND "kind" = 'CLOSE'`,
      [userId])).rows[0];
    check("a CLOSE row was written", !!close);
    check("the close was SENT to dxFeed (PLACED, not left QUEUED)",
      close?.status === "PLACED", `${close?.status}${close?.reason ? ` — ${close.reason}` : ""}`);

    await new Promise((r) => setTimeout(r, 3_000));
    console.log(`\n${passed} passed, ${failed} failed`);
    console.log("Confirm on the web platform that the account is flat with no resting orders.\n");
  } finally {
    // Belt and braces: flatten directly too, so a mid-test failure cannot leave
    // a resting order behind on the staging account.
    try { if (accountRef && client.isConnected()) await client.flatten(accountRef, "MES"); } catch { /* best effort */ }
    await new Promise((r) => setTimeout(r, 1_500));
    await client.stopAndDrain();
    setTradingClient(null);
    if (userId) {
      await pool.query(`DELETE FROM "signal"."CopyOrder" WHERE "userId" = $1`, [userId]);
      await deleteDxFeedLink(userId);
      await pool.query(`DELETE FROM "signal"."User" WHERE "id" = $1`, [userId]);
    }
    await pool.end();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("\ne2e failed:", (e as Error).message, "\n"); process.exit(1); });

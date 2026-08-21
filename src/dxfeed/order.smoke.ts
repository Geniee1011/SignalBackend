/* B12 — LIVE order round trip against dxFeed staging.
 *
 * Run: npx tsx src/dxfeed/order.smoke.ts --confirm
 *
 * THIS PLACES REAL ORDERS on a staging evaluation account, which is why it
 * refuses to run without --confirm. It is the last integration step the offline
 * tests cannot cover: OrderInsert -> ack correlation -> FLAT_CANCEL.
 *
 * WHY SEVERAL VARIANTS IN ONE RUN. A user gets 5 concurrent trading sessions and
 * a leaked one takes ~80 minutes to free up, so a session is expensive and each
 * run must extract as much as possible. The variants isolate the cause of an
 * unacknowledged order by changing ONE thing at a time:
 *
 *   A  limit far from market + bracket  — the original failing case
 *   B  limit far from market, no bracket — is the BRACKET rejected?
 *   C  market order, no bracket          — is the PRICE BAND the problem?
 *
 * C is the one that can actually fill. That is deliberate: it is the only variant
 * that proves the path end to end, the account is a $250k demo evaluation, and
 * the run flattens immediately afterwards.
 *
 * Every decoded frame is printed, because the client only acts on a handful of
 * message types — a reply we don't handle is otherwise indistinguishable from
 * silence, which is exactly the failure being diagnosed.
 */

import { dxfeedTradingReady } from "../config.js";
import { DxFeedTradingClient } from "./trading-ws.js";
import { loadSchema } from "./proto/codec.js";

const ROOT = "MES";
const FAR_PRICE = 100;        // far below any real MES level
const LOGIN_TIMEOUT_MS = 30_000;

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm")) {
    console.error("\nRefusing to run: this places REAL orders on dxFeed staging.\n  Re-run with --confirm.\n");
    process.exit(2);
  }
  if (!dxfeedTradingReady) { console.error("trading credentials are not set"); process.exit(1); }

  console.log("\ndxFeed live order round trip (staging)\n");
  await loadSchema();

  const client = new DxFeedTradingClient();
  // Print anything the server says that we don't already act on.
  client.setFrameLogger((m) => {
    for (const [k, v] of Object.entries(m)) {
      if (v == null || (Array.isArray(v) && v.length === 0)) continue;
      if (k === "SymbolLookup" || k === "InfoMsg" || k === "Pong") continue; // bulk/noise
      console.log(`      <<< ${k}: ${JSON.stringify(v).slice(0, 400)}`);
    }
  });

  try {
    await client.start();
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (!client.isConnected() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    if (!client.isConnected()) {
      const reason = client.loginFailureReason();
      throw new Error(
        reason
          ? `no login — the server said: "${reason}"`
          : "no login — no LoginMsg arrived at all (socket or auth problem)",
      );
    }

    await new Promise((r) => setTimeout(r, 3_000));
    const accounts = client.knownAccounts();
    if (accounts.length === 0) throw new Error("no accounts in the snapshot");

    console.log("  accounts:");
    for (const [ref, num] of accounts) {
      const a = client.accountInfoFor(ref)!;
      const why = client.blockedReason(ref);
      console.log(`    #${num} ${a.header.padEnd(10)} enabled=${a.isEnabled} trading=${a.isTradingEnabled} perm=${a.permission} status=${a.status} copier=${a.isTradeCopierAllowed}  ${why ? `BLOCKED: ${why}` : "OK"}`);
    }

    // --account=719 (or VP00719) targets one account. The trading-platform
    // selection in the web UI may be per-account, so "whichever is first" can
    // silently test a different account than the one that was just configured.
    const want = process.argv.find((a) => a.startsWith("--account="))?.split("=")[1]?.replace(/\D/g, "");
    const tradable = want
      ? accounts.find(([, num]) => String(num) === want)
      : accounts.find(([ref]) => client.blockedReason(ref) === null);
    if (!tradable) throw new Error(want ? `account ${want} not found on this session` : "no account can accept orders");
    const [accountRef, accountNumber] = tradable;
    const blocked = client.blockedReason(accountRef);
    if (blocked) throw new Error(`account ${accountNumber} cannot trade: ${blocked}`);
    const contractId = await client.resolveRoot(ROOT);
    const fm = client.frontMonthFor(ROOT)!;
    console.log(`\n  account  : ${accountRef} (#${accountNumber})`);
    console.log(`  contract : ${fm.feedSymbol} (id ${contractId})\n`);

    const variants: Array<{ name: string; order: Parameters<typeof client.placeEntry>[0] }> = [
      {
        name: `A  LIMIT @${FAR_PRICE} with bracket`,
        order: { accountId: accountRef, symbol: ROOT, side: "LONG", quantity: 1, limitPrice: FAR_PRICE, stopLoss: 50, takeProfit: 200 },
      },
      {
        name: `B  LIMIT @${FAR_PRICE} no bracket`,
        order: { accountId: accountRef, symbol: ROOT, side: "LONG", quantity: 1, limitPrice: FAR_PRICE, stopLoss: null, takeProfit: null },
      },
      {
        name: "C  MARKET 1 lot no bracket (CAN FILL)",
        order: { accountId: accountRef, symbol: ROOT, side: "LONG", quantity: 1, limitPrice: 0, stopLoss: null, takeProfit: null, orderType: "MARKET" },
      },
    ];

    // --no-market skips the only variant that can fill, for probing an account
    // we just want to know ACCEPTS orders (e.g. checking whether the web
    // platform's trading-platform selection is per-account).
    const selected = process.argv.includes("--no-market")
      ? variants.filter((v) => !v.name.startsWith("C"))
      : variants;

    for (const v of selected) {
      console.log(`  --- ${v.name}`);
      try {
        const res = await client.placeEntry(v.order);
        check(v.name, true, "");
        console.log(`      brokerOrderId = ${res.brokerOrderId}`);
      } catch (err) {
        check(v.name, false, (err as Error).message);
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }

    // --- always flatten, whatever happened above ---------------------------
    console.log("\n  flattening (FLAT_CANCEL)...");
    try {
      await client.flatten(accountRef, ROOT);
      check("flatten sent", true);
    } catch (err) {
      check("flatten sent", false, (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, 4_000));

    console.log(`\n${passed} passed, ${failed} failed`);
    console.log("Confirm on the web platform that the account is flat with no resting orders.\n");
  } finally {
    // A half-closed socket leaves the session open server-side; only 5 are
    // allowed and recovery takes ~80 minutes.
    await client.stopAndDrain();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("\nround trip failed:", (err as Error).message, "\n"); process.exit(1); });

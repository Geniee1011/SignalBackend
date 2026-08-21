/* B11 — LIVE staging probe for the Admin Trading API.
 *
 * Run: npx tsx src/dxfeed/trading.smoke.ts
 * Needs DXFEED_PLTF_KEY + DXFEED_SYSTEM_LOGIN + DXFEED_SYSTEM_PASSWORD in .env.
 *
 * READ-ONLY BY CONSTRUCTION — it authenticates, opens the socket, logs in, reads
 * the account snapshot and resolves contract ids. It places NO orders and sends
 * no cancel/flatten. Nothing here can move money, so it is safe to run against a
 * funded staging account at any time.
 *
 * It exists to answer the three things we could only assume while building
 * offline, in the order a real order would hit them:
 *
 *   1. Does the auth response parse?  (token + wss endpoint, header vs body)
 *   2. Does AccountReferenceId actually map to a numeric accountNumber?
 *   3. Does every root we trade resolve to a live front-month contract? (Settled
 *      2026-08-18: the API needs a DATED symbol, so roots are resolved against
 *      the session's SymbolLookup table rather than constructed.)
 */

import { config, dxfeedTradingReady } from "../config.js";
import { authenticate } from "./trading-auth.js";
import { DxFeedTradingClient } from "./trading-ws.js";
import { loadSchema } from "./proto/codec.js";
import { resolveSymbol } from "./symbols.js";

const LOGIN_TIMEOUT_MS = 30_000;
/** The roots the copy engine can size into (mini + micro across our markets). */
const OUR_ROOTS = ["ES", "MES", "NQ", "MNQ", "YM", "MYM", "GC", "MGC", "CL", "MCL", "RTY"];
const mask = (s: string): string => (s.length <= 8 ? "***" : `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars)`);

async function main(): Promise<void> {
  console.log("\ndxFeed Admin Trading API — live staging probe (read-only)\n");

  if (!dxfeedTradingReady) {
    console.error(
      "SKIPPED: trading credentials are not set.\n" +
      "  Set DXFEED_PLTF_KEY, DXFEED_SYSTEM_LOGIN and DXFEED_SYSTEM_PASSWORD in SignalBackend/.env.\n" +
      `  Currently: pltfKey=${config.dxfeed.trading.pltfKey ? "set" : "MISSING"}, ` +
      `login=${config.dxfeed.trading.systemLogin ? "set" : "MISSING"}, ` +
      `password=${config.dxfeed.trading.systemPassword ? "set" : "MISSING"}`,
    );
    process.exit(1);
  }

  await loadSchema();
  console.log(`  environment : ${config.dxfeed.environment}`);
  console.log(`  auth url    : ${config.dxfeed.trading.authUrl}`);
  console.log(`  login       : ${config.dxfeed.trading.systemLogin}\n`);

  // --- 1. auth -------------------------------------------------------------
  const auth = await authenticate();
  console.log("STEP 1  auth OK");
  console.log(`  token       : ${mask(auth.token)}`);
  console.log(`  wss         : ${auth.wssEndpoint}`);
  if (auth.reportHost) console.log(`  reportHost  : ${auth.reportHost}`);

  // --- 2. connect + login + account snapshot -------------------------------
  const client = new DxFeedTradingClient();
  try {
    await client.start();

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (!client.isConnected() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!client.isConnected()) throw new Error(`no login within ${LOGIN_TIMEOUT_MS / 1000}s — check the credential`);
    console.log("\nSTEP 2  socket open + login OK");

    // The snapshot is requested on login and arrives asynchronously; give it a moment.
    await new Promise((r) => setTimeout(r, 3_000));
    const accounts = client.knownAccounts();
    console.log(`  accounts    : ${accounts.length}`);
    for (const [ref, num] of accounts) console.log(`    ${ref}  ->  ${num}`);
    if (accounts.length === 0) {
      console.log("  ! no accounts in the snapshot — either this credential trades none,");
      console.log("    or AccountReferenceId is absent and the UUID->accountNumber map needs rework.");
    }

    // --- 3. front-month resolution for every root we trade ----------------
    console.log("\nSTEP 3  front-month contract per root");
    let missing = 0;
    for (const root of OUR_ROOTS) {
      // Two independent checks: the Propfirm REST list says it's tradeable at
      // all, and the trading session can actually name a contract for it. They
      // come from different dxFeed services and have disagreed before.
      const inPropfirm = (await resolveSymbol(root)) != null;
      try {
        const contractId = await client.resolveRoot(root);
        const fm = client.frontMonthFor(root)!;
        console.log(`  OK    ${root.padEnd(4)} ${fm.feedSymbol.padEnd(16)} id=${String(contractId).padEnd(9)} expiry=${fm.expiry}${inPropfirm ? "" : "   (! absent from the Propfirm symbol list)"}`);
      } catch (err) {
        missing += 1;
        console.log(`  FAIL  ${root.padEnd(4)} ${(err as Error).message}`);
      }
    }

    const roots = client.tradableRoots();
    console.log(`\n  session can trade ${roots.length} futures roots in total`);
    if (missing > 0) console.log(`  ! ${missing} of our ${OUR_ROOTS.length} roots did not resolve — those signals would skip`);

    console.log("\nDone. No orders were placed.\n");
  } finally {
    // Drain rather than stop(): a half-closed socket leaves the session open
    // server-side, and only 5 concurrent trading sessions are allowed per user.
    await client.stopAndDrain();
  }
}

main().catch((err) => { console.error("\nprobe failed:", err instanceof Error ? err.message : err, "\n"); process.exit(1); });

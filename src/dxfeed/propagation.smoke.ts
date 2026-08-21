/* B16 — how long after NewUser can a dxFeed user actually trade?
 *
 * Run: DXFEED_SYSTEM_LOGIN/_PASSWORD in the environment, then
 *   npx tsx src/dxfeed/propagation.smoke.ts --account=14541 [--created=2026-08-21T11:36:55Z]
 *                                           [--interval=5] [--max-hours=6] [--no-order-probe]
 *
 * WHY THIS EXISTS. Provisioning returns 200 long before the user can trade, and
 * the failure is staged and mostly silent:
 *
 *   1. login refused      — LoginMsg "Service is not available yet (user)"
 *   2. login OK, orders   — InfoReq and SymbolLookup answer normally while
 *      silently dropped     OrderInsert gets NO response at all. This is the
 *                           dangerous window: everything looks healthy.
 *   3. fully ready        — orders acked.
 *
 * The copy engine must not route a subscriber's signals until stage 3, or their
 * first trades vanish without an error. This measures where the boundaries are so
 * the readiness gate in provisionSubscriber() can be built on a real number.
 *
 * ORDER PROBE SAFETY: the probe is a LONG limit at 100 on MES — roughly 6000
 * points below any real level, so it rests and cannot fill — and every round ends
 * in FLAT_CANCEL. --no-order-probe measures stage 1 only (login), placing nothing.
 */

import { config, dxfeedTradingReady } from "../config.js";
import { DxFeedTradingClient } from "./trading-ws.js";
import { loadSchema } from "./proto/codec.js";

const ROOT = "MES";
const FAR_PRICE = 100;
const LOGIN_TIMEOUT_MS = 30_000;
const SNAPSHOT_SETTLE_MS = 3_000;

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const WANT_ACCOUNT = arg("account")?.replace(/\D/g, "");
const INTERVAL_MS = Number(arg("interval") ?? 5) * 60_000;
const MAX_MS = Number(arg("max-hours") ?? 6) * 3_600_000;
const ORDER_PROBE = !process.argv.includes("--no-order-probe");
const createdAt = arg("created") ? Date.parse(arg("created")!) : null;

const startedAt = Date.now();
const stamp = (): string => new Date().toISOString().slice(11, 19);
/** Age of the USER if we know when it was created, else time since probing began. */
const age = (): string => {
  const base = createdAt ?? startedAt;
  const mins = Math.round((Date.now() - base) / 60_000);
  return `${createdAt ? "user age" : "probing for"} ${mins}m`;
};

type Stage = "login-refused" | "orders-ignored" | "ready" | "error";

/** `loggedIn` is tracked separately from `stage`: an "error" round can happen
 *  either side of a successful login, and inferring stage 1 from "not refused"
 *  would let an unrelated crash masquerade as the login boundary. */
interface ProbeResult { stage: Stage; detail: string; loggedIn: boolean }

/** One full attempt on a FRESH session — start, login, optionally probe an order. */
async function probe(): Promise<ProbeResult> {
  const client = new DxFeedTradingClient();
  try {
    await client.start();
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (!client.isConnected() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));

    if (!client.isConnected()) {
      const reason = client.loginFailureReason();
      return { stage: "login-refused", detail: reason ?? "no LoginMsg arrived at all", loggedIn: false };
    }

    if (!ORDER_PROBE) return { stage: "ready", detail: "login OK (order probe disabled)", loggedIn: true };

    await new Promise((r) => setTimeout(r, SNAPSHOT_SETTLE_MS));
    const accounts = client.knownAccounts();
    if (accounts.length === 0) return { stage: "orders-ignored", detail: "logged in but no accounts in the snapshot", loggedIn: true };

    const target = WANT_ACCOUNT
      ? accounts.find(([, num]) => String(num) === WANT_ACCOUNT)
      : accounts.find(([ref]) => client.blockedReason(ref) === null);
    if (!target) {
      return {
        stage: "error",
        detail: WANT_ACCOUNT ? `account ${WANT_ACCOUNT} not on this session` : "no unblocked account",
        loggedIn: true,
      };
    }

    const [accountRef, accountNumber] = target;
    const blocked = client.blockedReason(accountRef);
    if (blocked) return { stage: "orders-ignored", detail: `account ${accountNumber} reports: ${blocked}`, loggedIn: true };

    try {
      const res = await client.placeEntry({
        accountId: accountRef, symbol: ROOT, side: "LONG",
        quantity: 1, limitPrice: FAR_PRICE, stopLoss: null, takeProfit: null,
      });
      return { stage: "ready", detail: `order acked on #${accountNumber}, brokerOrderId ${res.brokerOrderId}`, loggedIn: true };
    } catch (err) {
      // An ack timeout here IS the finding — the half-propagated window.
      return { stage: "orders-ignored", detail: `#${accountNumber}: ${(err as Error).message}`, loggedIn: true };
    } finally {
      // Always clear the probe order, even if placing "failed" — an order we
      // never got an ack for may still have reached the book.
      try { await client.flatten(accountRef, ROOT); } catch { /* nothing resting */ }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  } finally {
    // A half-closed socket strands the session server-side (only 5, ~80min to
    // recover), and this loop opens one per round.
    await client.stopAndDrain();
  }
}

async function main(): Promise<void> {
  if (!dxfeedTradingReady) { console.error("trading credentials are not set"); process.exit(1); }

  console.log("\ndxFeed — provisioning propagation window\n");
  console.log(`  login        : ${config.dxfeed.trading.systemLogin}`);
  console.log(`  account      : ${WANT_ACCOUNT ?? "(first unblocked)"}`);
  console.log(`  order probe  : ${ORDER_PROBE ? `yes — LONG limit @${FAR_PRICE} on ${ROOT}, cancelled each round` : "no (login only)"}`);
  console.log(`  interval     : ${INTERVAL_MS / 60_000}m, giving up after ${MAX_MS / 3_600_000}h`);
  if (createdAt) console.log(`  user created : ${new Date(createdAt).toISOString()}`);
  console.log("");

  await loadSchema();

  let loginFirstOkAt: number | null = null;
  let round = 0;

  while (Date.now() - startedAt < MAX_MS) {
    round++;
    let result: ProbeResult;
    try {
      result = await probe();
    } catch (err) {
      result = { stage: "error", detail: (err as Error).message, loggedIn: false };
    }

    console.log(`[${stamp()}] round ${round} (${age()}) — ${result.stage.toUpperCase()}: ${result.detail}`);

    if (result.loggedIn && loginFirstOkAt === null) {
      loginFirstOkAt = Date.now();
      const since = createdAt ? Math.round((loginFirstOkAt - createdAt) / 60_000) : null;
      console.log(`  >>> STAGE 1 CLEARED: login first succeeded${since !== null ? ` ${since}m after the user was created` : ""}`);
    }

    if (result.stage === "ready") {
      const since = createdAt ? Math.round((Date.now() - createdAt) / 60_000) : null;
      console.log(`\n  >>> STAGE 3 REACHED: orders accepted${since !== null ? ` ${since}m after the user was created` : ""}`);
      if (loginFirstOkAt && loginFirstOkAt !== Date.now()) {
        console.log(`  >>> the silent window (login OK but orders ignored) lasted about ` +
          `${Math.round((Date.now() - loginFirstOkAt) / 60_000)}m`);
      }
      console.log("\nThis is the number the readiness gate in provisionSubscriber() needs.\n");
      process.exit(0);
    }

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  console.log(`\nGave up after ${MAX_MS / 3_600_000}h — the user still cannot trade.`);
  console.log("That itself is a finding: propagation is slower than any sane provisioning gate,");
  console.log("so subscribers likely need an explicit readiness event from Volumetrica.\n");
  process.exit(1);
}

main().catch((err) => { console.error("\npropagation probe failed:", (err as Error).message, "\n"); process.exit(1); });

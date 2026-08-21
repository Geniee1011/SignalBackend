/* B4–B7 offline test — drives the client's dispatch with REAL encoded server
 * frames (encode → decode → dispatch), proving login handling, account mapping
 * (AccountReferenceId → accountNumber) and contract-request correlation without a
 * live socket. `send()` no-ops while the socket is null, so this is pure logic.
 *
 * Run: npx tsx src/dxfeed/trading-ws.test.ts
 */

import { encodeServerResponse, decodeServerResponse, OrderState, SnapType } from "./proto/codec.js";
import { DxFeedTradingClient, orderInfoOutcome } from "./trading-ws.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** Encode a ServerResponseMsg the way the server would, then hand the client the
 *  decoded object exactly as onFrame() would after decoding a binary frame. */
async function feed(client: DxFeedTradingClient, payload: Record<string, unknown>): Promise<void> {
  client.dispatch(await decodeServerResponse(await encodeServerResponse(payload)));
}

async function main(): Promise<void> {
  console.log("\ndxFeed trading client — dispatch & correlation (B4–B7)\n");
  const client = new DxFeedTradingClient();

  try {
    // Login success flips authenticated true.
    await feed(client, { LoginMsg: { Success: true } });
    check("login success → authenticated", client.authenticated === true);

    // Account snapshot maps our UUID (AccountReferenceId) → numeric accountNumber.
    await feed(client, {
      InfoMsg: {
        AccountList: [
          { accountNumber: 5551, accountHeader: "DFX-1", AccountReferenceId: "uuid-A" },
          { accountNumber: 5552, accountHeader: "DFX-2", AccountReferenceId: "uuid-B" },
        ],
      },
    });
    check("account uuid-A → 5551", client.accountNumberForRef("uuid-A") === 5551, `${client.accountNumberForRef("uuid-A")}`);
    check("account uuid-B → 5552", client.accountNumberForRef("uuid-B") === 5552);
    check("unknown account → undefined", client.accountNumberForRef("nope") === undefined);

    // Contract resolution: request in flight, then the ContractMsg resolves it.
    {
      const p = client.resolveContract("/MES:XCME");
      await feed(client, { ContractMsg: { FeedSymbol: "/MES:XCME", ContractId: 4242 } });
      const id = await p;
      check("resolveContract returns the contract id", id === 4242, `${id}`);
      // Second call is served from cache (resolves even with no new server msg).
      check("contract id is cached", (await client.resolveContract("/MES:XCME")) === 4242);
    }

    // A not-found contract (negative id) rejects rather than hanging.
    {
      const p = client.resolveContract("/ZZ:XCME").then(() => "resolved").catch(() => "rejected");
      await feed(client, { ContractMsg: { FeedSymbol: "/ZZ:XCME", ContractId: -1 } });
      check("unknown feed symbol rejects", (await p) === "rejected");
    }

    // --- symbol table → front month (B11) ---------------------------------
    // Mirrors a real SymbolLookup frame: futures mixed with equities, and roots
    // that carry TWO expiries because their roll is near (seen live on GC/CL).
    {
      await feed(client, {
        SymbolLookup: {
          RequestId: 1,
          Symbols: [
            { Symbol: "/MESU26:XCME", ContractId: 425641, Description: "MES-202609-CME" },
            { Symbol: "/GCZ26:XCEC", ContractId: 1867436, Description: "GC-202612-COMEX" },
            { Symbol: "/GCQ26:XCEC", ContractId: 1867432, Description: "GC-202608-COMEX" },
            { Symbol: "MESA&Q", ContractId: 306905088, Description: "Mesa Labs" },
            { Symbol: "/MYMU26:XCBT", ContractId: 3112617, Description: "MYM-202609-CBOT" },
          ],
        },
      });
      // Settle window (SYMBOLS_SETTLE_MS) — the table has no end-of-stream flag.
      await new Promise((r) => setTimeout(r, 900));

      check("root resolves to its contract id", (await client.resolveRoot("MES")) === 425641);
      check("resolution is case-insensitive", (await client.resolveRoot("mes")) === 425641);
      // The LATER expiry arrived first; nearest must still win, or a roll would
      // silently put orders in the back month depending on frame order.
      check("nearest expiry wins when two contracts share a root",
        (await client.resolveRoot("GC")) === 1867432, `${await client.resolveRoot("GC")}`);
      check("front month carries the dated feed symbol",
        client.frontMonthFor("GC")?.feedSymbol === "/GCQ26:XCEC", client.frontMonthFor("GC")?.feedSymbol);
      // "MESA&Q" starts with MES but is an equity — it must not shadow the future.
      check("equities in the same table are ignored", client.frontMonthFor("MESA") === undefined);
      check("multi-letter roots parse (MYM, not MY)", client.frontMonthFor("MYM")?.contractId === 3112617);
      check("only futures counted as tradable", client.tradableRoots().length === 3, `${client.tradableRoots().length}`);

      const unknown = await client.resolveRoot("ZZZ").then(() => "resolved").catch(() => "rejected");
      check("an unknown root rejects rather than hanging", unknown === "rejected");
    }

    // --- the roll: a refresh must REPLACE the table, not merge into it -------
    // Regression: the table was merged keeping the nearest expiry, so once GCQ26
    // expired its replacement (a LATER expiry) could never win and the session
    // would go on quoting a dead contract for as long as it stayed up.
    {
      await feed(client, {
        SymbolLookup: {
          RequestId: 2,
          Symbols: [
            { Symbol: "/GCZ26:XCEC", ContractId: 1867436, Description: "GC-202612-COMEX" },
            { Symbol: "/MESZ26:XCME", ContractId: 425642, Description: "MES-202612-CME" },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 900));

      check("after the roll the new front month wins",
        (await client.resolveRoot("GC")) === 1867436, `${await client.resolveRoot("GC")}`);
      check("the expired contract is gone from the table",
        client.frontMonthFor("GC")?.feedSymbol === "/GCZ26:XCEC", client.frontMonthFor("GC")?.feedSymbol);
      // Roots absent from the new table are dropped rather than lingering stale.
      check("a root missing from the refresh is dropped", client.frontMonthFor("MYM") === undefined);
      check("the refreshed table replaced the old one", client.tradableRoots().length === 2,
        `${client.tradableRoots().length}`);
    }

    // An empty/failed refresh must not wipe a working table — losing it would
    // make every order unresolvable until the next successful fetch.
    {
      await feed(client, { SymbolLookup: { RequestId: 3, Symbols: [{ Symbol: "AAPL", ContractId: 1, Description: "Apple" }] } });
      await new Promise((r) => setTimeout(r, 900));
      check("a futures-less refresh keeps the previous table",
        (await client.resolveRoot("GC")) === 1867436, `${await client.resolveRoot("GC")}`);
    }

    // --- order acknowledgement: what counts as "placed" -------------------
    {
      check("a realtime ack resolves to the server id",
        orderInfoOutcome({ SnapType: SnapType.RealTime, OrderState: OrderState.Submitted, OrgServerId: 9001 })
          .kind === "resolve");

      // Regression: a broker REJECTION was resolved like a success, so the engine
      // would record a position that does not exist.
      const rejected = orderInfoOutcome({
        SnapType: SnapType.RealTime, OrderState: OrderState.Error, Reason: "insufficient margin", OrgServerId: 9002,
      });
      check("an Error state rejects instead of resolving", rejected.kind === "reject", rejected.kind);
      check("the broker's reason is preserved",
        rejected.kind === "reject" && rejected.reason === "insufficient margin");
      check("a failed MODIFY also rejects",
        orderInfoOutcome({ SnapType: SnapType.RealTime, OrderState: OrderState.ErrorModify }).kind === "reject");

      // Regression: login replays old orders whose SeqClientId can collide with
      // our per-session counter (which restarts at 1), so a historical row could
      // satisfy a pending order and report a placement that never happened.
      check("a historical snapshot is ignored",
        orderInfoOutcome({ SnapType: SnapType.Historical, OrderState: OrderState.Submitted, OrgServerId: 1 })
          .kind === "ignore");
      check("a portfolio snapshot is ignored",
        orderInfoOutcome({ SnapType: SnapType.HistPos, OrderState: OrderState.Submitted }).kind === "ignore");
      // Absent SnapType must NOT be treated as historical — that would drop real acks.
      check("a missing SnapType still resolves",
        orderInfoOutcome({ OrderState: OrderState.Submitted, OrgServerId: 9003 }).kind === "resolve");
    }

    // New account arriving live via AccountStatusUpdates (header wrapped in .Info).
    await feed(client, { AccountStatusUpdates: [{ AccountId: 5553, Action: 0, Info: { accountNumber: 5553, accountHeader: "DFX-3", AccountReferenceId: "uuid-C" } }] });
    check("live new account uuid-C → 5553", client.accountNumberForRef("uuid-C") === 5553, `${client.accountNumberForRef("uuid-C")}`);
  } finally {
    client.stop(); // clear the ping timer started at login
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error("trading-ws test crashed:", err); process.exit(1); });
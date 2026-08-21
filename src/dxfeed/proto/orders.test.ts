/* B1 test — the order builders produce valid frames that round-trip through the
 * real .proto, with the tricky bits correct: short = negative qty, brackets on
 * both sides, Source=Copy, cancel/flat action.
 *
 * Run: npx tsx src/dxfeed/proto/orders.test.ts
 */

import { encodeClientRequest, decodeClientRequest, OrderType, RequestSource, CancelFlatAction, BracketType } from "./codec.js";
import { loginReq, pingReq, accountSnapshotReq, contractReq, orderInsert, orderRemove, cancelFlat } from "./orders.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function roundtrip(payload: Record<string, unknown>): Promise<Record<string, any>> {
  return decodeClientRequest(await encodeClientRequest(payload));
}

async function main(): Promise<void> {
  console.log("\ndxFeed order builders (B1)\n");

  check("loginReq encodes", (await roundtrip(loginReq("tok"))).LoginReq?.Token === "tok");
  check("pingReq encodes", (await encodeClientRequest(pingReq())).length >= 0);
  check("accountSnapshotReq has 3 modes", JSON.stringify((await roundtrip(accountSnapshotReq())).InfoReq?.Modes) === JSON.stringify([1, 2, 3]));
  check("contractReq carries feed symbol", (await roundtrip(contractReq("/MESZ25:XCME"))).ContractReq?.FeedSymbol === "/MESZ25:XCME");

  // SHORT bracketed entry (the counter-signal case).
  {
    const oi = (await roundtrip(orderInsert({
      accountNumber: 555, contractId: 7, seqClientId: 1, side: "SHORT",
      quantity: 3, limitPrice: 7451.25, stopLoss: 7461.25, takeProfit: 7446.25,
    }))).Order?.[0]?.OrderInsert;
    check("SHORT → negative quantity", oi?.Quantity === -3, `${oi?.Quantity}`);
    check("limit price set", oi?.Price === 7451.25);
    check("order type Limit", oi?.OrderType === OrderType.Limit);
    check("tagged Source=Copy", oi?.Source === RequestSource.Copy, `${oi?.Source}`);
    // STOP_AND_TARGET is enum 0 = proto3 default, so it's omitted on the wire and
    // decodes as undefined — which the server reads back as STOP_AND_TARGET.
    check("bracket type STOP_AND_TARGET (proto3 default)", (oi?.BracketStrategy?.Type ?? BracketType.STOP_AND_TARGET) === BracketType.STOP_AND_TARGET, `${oi?.BracketStrategy?.Type}`);
    check("stop leg abs qty + price", oi?.BracketStrategy?.Stops?.[0]?.Quantity === 3 && oi?.BracketStrategy?.Stops?.[0]?.Price === 7461.25);
    check("target leg price", oi?.BracketStrategy?.Targets?.[0]?.Price === 7446.25);
  }

  // LONG, stop-only bracket.
  {
    const oi = (await roundtrip(orderInsert({
      accountNumber: 555, contractId: 7, seqClientId: 2, side: "LONG",
      quantity: 2, limitPrice: 100, stopLoss: 95, takeProfit: null,
    }))).Order?.[0]?.OrderInsert;
    check("LONG → positive quantity", oi?.Quantity === 2, `${oi?.Quantity}`);
    check("stop-only bracket type STOP", oi?.BracketStrategy?.Type === BracketType.STOP, `${oi?.BracketStrategy?.Type}`);
    check("stop-only has no targets", !(oi?.BracketStrategy?.Targets?.length), JSON.stringify(oi?.BracketStrategy?.Targets));
  }

  // No-bracket entry (unsized protective legs) → no BracketStrategy at all.
  {
    const oi = (await roundtrip(orderInsert({
      accountNumber: 555, contractId: 7, seqClientId: 3, side: "LONG", quantity: 1, limitPrice: 50,
    }))).Order?.[0]?.OrderInsert;
    check("no SL/TP → no bracket", oi?.BracketStrategy == null, JSON.stringify(oi?.BracketStrategy));
  }

  // Cancel/flat and order-remove.
  {
    const cf = (await roundtrip(cancelFlat(555, 7))).CancelFlatReq;
    check("cancelFlat action FLAT_CANCEL", cf?.Action === CancelFlatAction.FLAT_CANCEL, `${cf?.Action}`);
    check("cancelFlat targets the contract", JSON.stringify(cf?.ContractsId) === JSON.stringify([7]));
    const rm = (await roundtrip(orderRemove(555, 99999))).Order?.[0]?.OrderRemove;
    check("orderRemove carries server id", rm?.OrgServerId === 99999, `${rm?.OrgServerId}`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error("orders test crashed:", err); process.exit(1); });
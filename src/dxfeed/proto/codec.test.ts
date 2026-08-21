/* Round-trips real dxFeed trading messages through protobufjs — proving the
 * shipped .proto works in our Node/TS stack. No network: pure encode↔decode.
 *
 * Run: npx tsx src/dxfeed/proto/codec.test.ts
 */

import {
  encodeClientRequest, decodeClientRequest,
  encodeServerResponse, decodeServerResponse,
  OrderType, InfoMode, AccountSubscriptionMode,
} from "./codec.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function main(): Promise<void> {
  console.log("\ndxFeed trading protobuf codec\n");

  // 1) Login request — the first frame after the socket opens.
  {
    const bytes = await encodeClientRequest({
      LoginReq: { Token: "tok-abc-123", AccountSubscriptionMode: AccountSubscriptionMode.Existing },
    });
    check("client frame is non-empty binary", bytes instanceof Uint8Array && bytes.length > 0, `${bytes.length}`);
    const back = await decodeClientRequest(bytes);
    check("LoginReq.Token round-trips", back.LoginReq?.Token === "tok-abc-123", JSON.stringify(back.LoginReq));
    check("AccountSubscriptionMode round-trips", back.LoginReq?.AccountSubscriptionMode === 2);
  }

  // 2) Order insert — a SHORT (counter-signal) as a limit with brackets.
  //    Short == NEGATIVE quantity (dxFeed's convention).
  {
    const bytes = await encodeClientRequest({
      Order: [{
        OrderInsert: {
          AccNumber: 987654321,
          ContractId: 12345,
          SeqClientId: 7,
          OrderType: OrderType.Limit,
          Quantity: -3,          // short 3 micros
          Price: 7451.25,
          // Real bracket shape: a STOP_AND_TARGET strategy with abs-quantity legs.
          BracketStrategy: {
            Type: 0, // STOP_AND_TARGET
            Stops: [{ Quantity: 3, Price: 7461.25 }],
            Targets: [{ Quantity: 3, Price: 7446.25 }],
          },
        },
      }],
    });
    const back = await decodeClientRequest(bytes);
    const oi = back.Order?.[0]?.OrderInsert;
    check("order carries account number", oi?.AccNumber === 987654321, `${oi?.AccNumber}`);
    check("order carries contract id", oi?.ContractId === 12345, `${oi?.ContractId}`);
    check("SHORT is a negative quantity", oi?.Quantity === -3, `${oi?.Quantity}`);
    check("limit price round-trips (double)", oi?.Price === 7451.25, `${oi?.Price}`);
    check("order type = Limit(1)", oi?.OrderType === OrderType.Limit, `${oi?.OrderType}`);
    const bs = oi?.BracketStrategy;
    check("bracket stop leg attached", bs?.Stops?.[0]?.Price === 7461.25 && bs?.Stops?.[0]?.Quantity === 3, JSON.stringify(bs));
    check("bracket target leg attached", bs?.Targets?.[0]?.Price === 7446.25, JSON.stringify(bs));
  }

  // 3) InfoReq with multiple modes (account list + orders/positions snapshot).
  {
    const bytes = await encodeClientRequest({ InfoReq: { Modes: [InfoMode.Account, InfoMode.OrdAndPos] } });
    const back = await decodeClientRequest(bytes);
    check("InfoReq.Modes round-trips", JSON.stringify(back.InfoReq?.Modes) === JSON.stringify([1, 2]), JSON.stringify(back.InfoReq?.Modes));
  }

  // 4) Contract lookup — resolve a dxFeed feed symbol to a contract id.
  {
    const bytes = await encodeClientRequest({ ContractReq: { FeedSymbol: "/ESZ25:XCME" } });
    const back = await decodeClientRequest(bytes);
    check("ContractReq.FeedSymbol round-trips", back.ContractReq?.FeedSymbol === "/ESZ25:XCME", JSON.stringify(back.ContractReq));
  }

  // 5) Server → client: a login success frame decodes as the server would send it.
  {
    const bytes = await encodeServerResponse({ LoginMsg: { Success: true } });
    const back = await decodeServerResponse(bytes);
    check("server LoginMsg.Success decodes", back.LoginMsg?.Success === true, JSON.stringify(back.LoginMsg));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error("codec test crashed:", err); process.exit(1); });
import {
  OrderType, InfoMode, AccountSubscriptionMode, PriceMode, RequestSource, BracketType, CancelFlatAction,
} from "./codec.js";

/* Pure builders for the ClientRequestMsg payloads we send over the trading WSS.
 *
 * Kept separate from the socket (trading-ws.ts) so the message SHAPE — the part
 * that's easy to get subtly wrong (signed quantity for shorts, bracket legs,
 * Source=Copy) — is unit-testable by round-tripping through the codec, with no
 * network. The socket layer just calls these and sends the encoded bytes. */

/** First frame after the socket opens. ExistingAndNew = auto-subscribe all the
 *  user's accounts AND get told about new ones without reconnecting. */
export function loginReq(token: string, mode: number = AccountSubscriptionMode.ExistingAndNew) {
  return { LoginReq: { Token: token, AccountSubscriptionMode: mode } };
}

/** Heartbeat — must be sent at least every ~45s or the server drops us. */
export function pingReq() {
  return { Ping: {} };
}

/** Initial snapshot: account list + orders/positions. Store accountNumbers. */
export function accountSnapshotReq() {
  return { InfoReq: { Modes: [InfoMode.Account, InfoMode.OrdAndPos, InfoMode.Positions] } };
}

/** Resolve a dxFeed feed symbol (e.g. "/MESU26:XCME") to a contract id. */
export function contractReq(feedSymbol: string) {
  return { ContractReq: { FeedSymbol: feedSymbol } };
}

/**
 * Every tradable symbol, with its contract id. Per the protocol this "always
 * returns the front month contract, and the next contract if the expiration is
 * closer" — which is how we avoid constructing dated symbols like "/MESU26:XCME"
 * ourselves and re-deriving the roll calendar for four different exchanges.
 *
 * The filter is optional and we deliberately don't use it: one unfiltered sweep
 * at login costs a single frame and gives every root at once, where per-symbol
 * lookups would be a round-trip each on a path that must not stall an order.
 */
export function symbolLookupReq(requestId = 1) {
  return { SymbolLookup: { RequestId: requestId } };
}

export interface EntryParams {
  accountNumber: number;
  contractId: number;
  /** Unique per session — echoed back on status updates so we can track the fill. */
  seqClientId: number;
  side: "LONG" | "SHORT";
  /** Positive count; the sign is applied here from `side`. */
  quantity: number;
  limitPrice: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** Defaults to a LIMIT entry worked at `limitPrice`. MARKET ignores the price. */
  orderType?: "LIMIT" | "MARKET";
}

/**
 * A bracketed LIMIT entry. dxFeed's convention: SELL == NEGATIVE quantity. The
 * bracket legs carry an ABS quantity (their side is derived from the parent), a
 * Price mode, and the absolute stop/target price. Source=Copy tags it for dxFeed's
 * diagnostics as a copy-trade.
 */
export function orderInsert(p: EntryParams) {
  const qty = Math.abs(p.quantity);
  const market = p.orderType === "MARKET";
  const insert: Record<string, unknown> = {
    AccNumber: p.accountNumber,
    ContractId: p.contractId,
    SeqClientId: p.seqClientId,
    OrderType: market ? OrderType.Market : OrderType.Limit,
    Quantity: p.side === "SHORT" ? -qty : qty,
    // A market order carries no price; sending one is at best ignored and at
    // worst read as a trigger price.
    Price: market ? 0 : p.limitPrice,
    Source: RequestSource.Copy,
  };

  const stops = p.stopLoss != null ? [{ Quantity: qty, PriceMode: PriceMode.Price, Price: p.stopLoss }] : [];
  const targets = p.takeProfit != null ? [{ Quantity: qty, PriceMode: PriceMode.Price, Price: p.takeProfit }] : [];
  if (stops.length || targets.length) {
    const Type = stops.length && targets.length ? BracketType.STOP_AND_TARGET : stops.length ? BracketType.STOP : BracketType.TARGET;
    insert.BracketStrategy = { Type, Stops: stops, Targets: targets };
  }

  return { Order: [{ OrderInsert: insert }] };
}

/** Cancel a still-resting entry by its server id (from OrderInfoMsg.OrgServerId). */
export function orderRemove(accountNumber: number, orgServerId: number) {
  return { Order: [{ OrderRemove: { AccNumber: accountNumber, OrgServerId: orgServerId } }] };
}

/**
 * Close out a contract: cancel any resting orders AND flatten the position. When
 * contractId is omitted the action applies to the whole account. This is how a
 * CLOSE is executed in push mode (mirrors the trader going flat, and handles the
 * limit-never-filled case in one shot).
 */
export function cancelFlat(accountNumber: number, contractId?: number) {
  return {
    CancelFlatReq: {
      AccNumber: accountNumber,
      Action: CancelFlatAction.FLAT_CANCEL,
      Source: RequestSource.Copy,
      ...(contractId != null ? { ContractsId: [contractId] } : {}),
    },
  };
}
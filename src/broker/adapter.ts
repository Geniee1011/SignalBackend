import type { Signal } from "../signals/source.js";

/* The broker seam.
 *
 * The copy engine decides WHAT to trade; an adapter decides HOW to send it. Every
 * broker path we've evaluated — Tradovate REST, an ATAS/NinjaTrader plugin that
 * pulls from us, Rithmic — differs only in this final step, so it is the one
 * thing behind an interface. Nothing above this file may import a broker SDK.
 *
 * Two execution shapes are supported deliberately:
 *
 *  - PUSH ("we place it"): the adapter calls the broker itself, e.g. Tradovate.
 *  - PULL ("they collect it"): the adapter only records the intent, and the
 *    subscriber's own software (an ATAS/NinjaTrader strategy) fetches and places
 *    it. Nothing is sent anywhere; we never hold broker credentials.
 *
 * The PULL shape is why `placeOrder` returns a result rather than throwing on a
 * business rejection — "queued for the user's terminal" is a success, not a
 * failure, and the engine must be able to tell those apart. */

export interface OrderIntent {
  /** The signal this order came from — the idempotency key. */
  signalId: string;
  userId: string;
  /** Root symbol as the signal carries it ("ES"), not a dated contract. */
  symbol: string;
  /** Signal side — already inverted from the trader's position. */
  side: "LONG" | "SHORT";
  quantity: number;
  /** Protective levels, already swapped for the counter-side. May be absent. */
  stopLoss: number | null;
  takeProfit: number | null;
  /** Reference entry from the signal — informational; entries are market orders. */
  referencePrice: number;
  conviction: number;
}

export interface PlaceResult {
  ok: boolean;
  /** Broker's id when it placed immediately; null for queued (pull-mode) orders. */
  brokerOrderId?: string | null;
  /** Set when ok=false — surfaced to the user, so it must be human-readable. */
  error?: string;
  /**
   * True when the order was recorded for the subscriber's terminal to collect
   * rather than sent to a broker. Still a success — just not a fill yet.
   */
  queued?: boolean;
}

export interface BrokerAdapter {
  /** Stable id stored on CopyOrder rows, e.g. "mock" | "atas" | "tradovate". */
  readonly name: string;
  /**
   * True when this user can currently receive orders (linked, not errored).
   * The engine checks this BEFORE building an order so a disconnected broker
   * is reported as a skip rather than a rejection.
   */
  isReady(userId: string): Promise<boolean>;
  placeOrder(intent: OrderIntent): Promise<PlaceResult>;
}

/** Build the order intent for a signal — the counter-side is already in the signal. */
export function toIntent(signal: Signal, userId: string, quantity: number): OrderIntent {
  return {
    signalId: signal.id,
    userId,
    symbol: signal.market || signal.symbol,
    side: signal.side,
    quantity,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    referencePrice: signal.entry,
    conviction: signal.conviction,
  };
}

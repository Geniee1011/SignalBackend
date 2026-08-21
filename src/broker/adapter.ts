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
  /**
   * The signal's entry price — worked as a LIMIT price, not just informational.
   *
   * A market entry fills at whatever the book offers, which in a fast market is
   * where a copied result stops resembling the published one. The trade-off is
   * that a limit may never fill, so "we never got in" becomes a real state the
   * rest of the system has to handle (see queueCloses).
   */
  referencePrice: number;
  conviction: number;
}

/**
 * The exit of a copied signal — "this signal is over, get out of it".
 *
 * Carries the ENTRY's own values, not a fresh trade's: an adapter FLATTENS this
 * position. It must never send an opposite-side order, which on an already-flat
 * account opens a brand-new reversed position instead of closing anything.
 */
export interface CloseIntent {
  signalId: string;
  userId: string;
  /** The symbol the ENTRY was placed in — already the risk-sized (usually micro) root. */
  symbol: string;
  /** The ENTRY's side. Informational: the adapter flattens, it does not trade this. */
  side: "LONG" | "SHORT";
  quantity: number;
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
  /**
   * PUSH adapters only: actually send the exit.
   *
   * ABSENT means PULL semantics — the engine records the CLOSE and the
   * subscriber's terminal collects it, which is why this is optional rather than
   * a no-op every pull adapter has to implement. Defining it flips the engine
   * from "record the close" to "record AND send the close".
   *
   * Returning ok=false is RETRYABLE: the close stays QUEUED and the next tick
   * tries again. That is the opposite of placeOrder's failure handling, and
   * deliberately so — a missed entry is a missed opportunity, but a missed exit
   * leaves a real position open after the trader is already out of it. The risk
   * of retrying is nil because flattening an already-flat account is a no-op,
   * whereas the risk of giving up is an unbounded live position.
   */
  closeOrder?(close: CloseIntent): Promise<PlaceResult>;
}

/**
 * Build the order intent for a signal — the counter-side is already in the signal.
 * `sized` carries the SYMBOL and QUANTITY chosen by risk sizing (typically the
 * micro contract), which is why they are passed in rather than read off the signal:
 * the signal names the mini root, but we may trade the micro to hit a risk target.
 */
export function toIntent(
  signal: Signal,
  userId: string,
  sized: { symbol: string; quantity: number },
): OrderIntent {
  return {
    signalId: signal.id,
    userId,
    symbol: sized.symbol,
    side: signal.side,
    quantity: sized.quantity,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    referencePrice: signal.entry,
    conviction: signal.conviction,
  };
}

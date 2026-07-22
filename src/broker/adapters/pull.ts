import type { BrokerAdapter, OrderIntent, PlaceResult } from "../adapter.js";

/* PULL adapter — for terminals that fetch their own work (ATAS, NinjaTrader,
 * Quantower).
 *
 * We never contact a broker and never hold credentials: the engine records the
 * order, and the subscriber's own strategy collects it over
 * /api/copy/orders and places it through whatever broker their platform is
 * already connected to. That is the whole point of this shape — the broker
 * relationship stays entirely between the user and their platform.
 *
 * `placeOrder` therefore does no I/O. The engine has already written the
 * CopyOrder row by the time it's called; this just reports "queued, not filled"
 * so the row lands in QUEUED rather than PLACED. Marking it PLACED here would
 * claim a fill that hasn't happened — the strategy confirms that later via the
 * ack endpoint. */

export class PullAdapter implements BrokerAdapter {
  readonly name: string;

  constructor(name = "pull") {
    this.name = name;
  }

  /**
   * Always ready. A pull terminal is offline more often than not (the user's PC
   * is off), but that must NOT block queueing — the orders wait for them. Any
   * that go stale are expired by maxAgeMs on collection, not refused here.
   */
  async isReady(): Promise<boolean> {
    return true;
  }

  async placeOrder(_intent: OrderIntent): Promise<PlaceResult> {
    return { ok: true, queued: true, brokerOrderId: null };
  }
}

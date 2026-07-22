import type { BrokerAdapter, OrderIntent, PlaceResult } from "../adapter.js";

/* In-memory adapter for testing the engine without a broker.
 *
 * Records every call so tests can assert not just the outcome but exactly what
 * would have been sent — a wrong side or quantity reaching a real broker is the
 * failure mode that matters most here. */

export class MockAdapter implements BrokerAdapter {
  readonly name = "mock";
  readonly placed: OrderIntent[] = [];

  constructor(
    private opts: {
      ready?: boolean;
      /** Force a business rejection (an order the broker refuses). */
      reject?: string;
      /** Force a thrown error (network/exception path). */
      throws?: boolean;
      /** Report as queued rather than filled — the pull-mode shape. */
      queued?: boolean;
    } = {},
  ) {}

  async isReady(): Promise<boolean> {
    return this.opts.ready !== false;
  }

  async placeOrder(intent: OrderIntent): Promise<PlaceResult> {
    if (this.opts.throws) throw new Error("network exploded");
    if (this.opts.reject) return { ok: false, error: this.opts.reject };
    this.placed.push(intent);
    return this.opts.queued
      ? { ok: true, queued: true, brokerOrderId: null }
      : { ok: true, brokerOrderId: `mock-${this.placed.length}` };
  }
}

/* The execution seam for the dxFeed Admin Trading API (WebSocket + Protobuf).
 *
 * The interface is what the DxFeedAdapter is written against; the concrete
 * transport (DxFeedTradingClient in trading-ws.ts) is injected at startup by
 * selectExecutionAdapter(). Keeping them apart is what lets the adapter and the
 * copy engine be tested with no socket, and what kept the adapter finished while
 * the Protobuf transport was still missing.
 *
 * `getTradingClient()` returns null when execution isn't configured at all
 * (EXECUTION_ADAPTER != dxfeed, or the trading credentials are unset), and the
 * adapter reports that as unavailable — a clean skip, never a bad order. */

export interface DxEntryOrder {
  /** Our dxFeed account UUID (dxAccountId) — mapped to the numeric accountNumber
   *  the trading API uses via AccountReferenceId at session time. */
  accountId: string;
  /**
   * OUR root symbol, e.g. "MES" — already the risk-sized (usually micro) root.
   *
   * Deliberately NOT a dated feed symbol like "/MESU26:XCME": the session's own
   * symbol table resolves the root to whatever contract is front month right now,
   * so nothing above this seam has to track roll calendars.
   */
  symbol: string;
  /** Signal side — already inverted to the counter-side by the copy engine. */
  side: "LONG" | "SHORT";
  quantity: number;
  /** Worked as a LIMIT entry at the signal's price. */
  limitPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Defaults to LIMIT — the copy engine always works the signal's price. */
  orderType?: "LIMIT" | "MARKET";
}

export interface DxTradingClient {
  /** True when the WSS session is authenticated and ready to accept orders. */
  isConnected(): boolean;
  /** Place a bracketed limit entry. Resolves with the broker's order id. */
  placeEntry(order: DxEntryOrder): Promise<{ brokerOrderId: string }>;
  /** Flatten any open position (and cancel a still-resting entry) for a root symbol. */
  flatten(accountId: string, symbol: string): Promise<void>;

  /* --- session introspection, used by the readiness gate ------------------
   * Optional so the in-memory test doubles stay tiny; when absent the gate
   * simply skips the corresponding check rather than failing closed on a fake.
   * The live DxFeedTradingClient implements both. */

  /** The numeric accountNumber for one of our account UUIDs, if this session
   *  knows it at all. Absent = the account is not in the session snapshot, which
   *  is the state a not-yet-usable provisioned account presents as. */
  accountNumberForRef?(accountId: string): number | undefined;
  /** Why this account would refuse an order, or null if it should accept one. */
  blockedReason?(accountId: string): string | null;
}

let client: DxTradingClient | null = null;

/** Inject the live trading client (Part B) at startup. Pass null to unset. */
export function setTradingClient(c: DxTradingClient | null): void {
  client = c;
}

/** The live client, or null when execution isn't available yet (no `.proto`). */
export function getTradingClient(): DxTradingClient | null {
  return client;
}

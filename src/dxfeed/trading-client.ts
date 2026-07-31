/* The execution seam for the dxFeed Admin Trading API (WebSocket + Protobuf).
 *
 * This interface is defined NOW so the DxFeedAdapter is fully wired and only the
 * Protobuf transport drops in behind it (Part B). Building the concrete client
 * needs the `.proto` message definitions from dxFeed — until they arrive,
 * `getTradingClient()` returns null and the adapter reports execution as
 * unavailable (a clean skip, never a bad order).
 *
 * Part B implements `DxTradingClient` over the WSS (login with a fullTrading
 * system credential, insert order + brackets, flatten) and injects it via
 * `setTradingClient()` at startup. Nothing above this seam changes when it lands. */

export interface DxEntryOrder {
  /** dxFeed trading account the order lands on (from the subscriber's link). */
  accountId: string;
  /** dxFeed instrument id (from symbols.ts). */
  symbolId: number;
  /** Signal side — already inverted to the counter-side by the copy engine. */
  side: "LONG" | "SHORT";
  quantity: number;
  /** Worked as a LIMIT entry at the signal's price. */
  limitPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface DxTradingClient {
  /** True when the WSS session is authenticated and ready to accept orders. */
  isConnected(): boolean;
  /** Place a bracketed limit entry. Resolves with the broker's order id. */
  placeEntry(order: DxEntryOrder): Promise<{ brokerOrderId: string }>;
  /** Flatten any open position (and cancel a still-resting entry) for a contract. */
  flatten(accountId: string, symbolId: number): Promise<void>;
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

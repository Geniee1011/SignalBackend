import type { BrokerAdapter, OrderIntent, PlaceResult } from "../broker/adapter.js";
import { getDxFeedLink } from "./store.js";
import { resolveSymbol } from "./symbols.js";
import { getTradingClient } from "./trading-client.js";
import { AccountStatus } from "./types.js";

/* dxFeed execution adapter — the PUSH replacement for the ATAS pull path.
 *
 * The copy engine hands us an OrderIntent (side already inverted, size already
 * chosen in micro contracts). We resolve the subscriber's dxFeed account and the
 * dxFeed instrument, then place the order over the Admin Trading API via the
 * injected DxTradingClient. Everything above this — allocation, caps, sizing —
 * is unchanged; swapping ATAS for dxFeed is exactly this class.
 *
 * Until the trading `.proto` lands the client is absent, so placeOrder reports a
 * clean, human-readable failure rather than sending anything. Consistent with the
 * engine's "under-trade rather than over-trade" rule. */

export class DxFeedAdapter implements BrokerAdapter {
  readonly name = "dxfeed";

  async isReady(userId: string): Promise<boolean> {
    const link = await getDxFeedLink(userId);
    if (!link?.dxAccountId) return false;
    // Only tradeable while Enabled or having passed; Failed/Disabled cannot trade.
    if (
      link.accountStatus != null &&
      link.accountStatus !== AccountStatus.ENABLED &&
      link.accountStatus !== AccountStatus.CHALLENGE_SUCCESS
    ) return false;
    const client = getTradingClient();
    return client != null && client.isConnected();
  }

  async placeOrder(intent: OrderIntent): Promise<PlaceResult> {
    const link = await getDxFeedLink(intent.userId);
    if (!link?.dxAccountId) return { ok: false, error: "no dxFeed account linked for this subscriber" };

    const sym = await resolveSymbol(intent.symbol);
    if (!sym) return { ok: false, error: `symbol ${intent.symbol} is not tradeable on dxFeed` };

    const client = getTradingClient();
    if (!client || !client.isConnected()) {
      return { ok: false, error: "dxFeed trading session unavailable (awaiting trading .proto)" };
    }

    try {
      const res = await client.placeEntry({
        accountId: link.dxAccountId,
        symbolId: sym.id,
        side: intent.side,
        quantity: intent.quantity,
        limitPrice: intent.referencePrice,
        stopLoss: intent.stopLoss,
        takeProfit: intent.takeProfit,
      });
      return { ok: true, brokerOrderId: res.brokerOrderId };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

import type { BrokerAdapter, CloseIntent, OrderIntent, PlaceResult } from "../broker/adapter.js";
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
 * When the trading session is down (or its credentials unset) the client is
 * absent, so placeOrder reports a clean, human-readable failure rather than
 * sending anything. Consistent with the engine's "under-trade rather than
 * over-trade" rule — with closeOrder the deliberate exception, since not exiting
 * is the riskier failure. */

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
      return { ok: false, error: "dxFeed trading session unavailable" };
    }

    try {
      const res = await client.placeEntry({
        accountId: link.dxAccountId,
        symbol: sym.name,
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

  /**
   * Send the exit. One FLAT_CANCEL per contract resolves all three states the
   * engine can be in — filled (flatten it), never filled (cancel the resting
   * limit), partially filled (both) — which is why the fill state we don't track
   * on this side never has to be guessed.
   *
   * Deliberately NOT gated on isReady(): a subscriber whose account has since
   * been disabled or failed still holds whatever the entry opened, and refusing
   * to close it is the one outcome worse than closing it late. Only a genuinely
   * unusable session (no link, no socket) stops us, and those return ok=false so
   * the engine retries rather than marking the position closed.
   */
  async closeOrder(close: CloseIntent): Promise<PlaceResult> {
    const link = await getDxFeedLink(close.userId);
    if (!link?.dxAccountId) return { ok: false, error: "no dxFeed account linked for this subscriber" };

    const sym = await resolveSymbol(close.symbol);
    if (!sym) return { ok: false, error: `symbol ${close.symbol} is not tradeable on dxFeed` };

    const client = getTradingClient();
    if (!client || !client.isConnected()) return { ok: false, error: "dxFeed trading session unavailable" };

    try {
      await client.flatten(link.dxAccountId, sym.name);
      return { ok: true, brokerOrderId: null };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

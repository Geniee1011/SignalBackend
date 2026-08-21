import { config, dxfeedTradingReady } from "../config.js";
import type { BrokerAdapter } from "../broker/adapter.js";
import { PullAdapter } from "../broker/adapters/pull.js";
import { DxFeedAdapter } from "./adapter.js";
import { DxFeedTradingClient } from "./trading-ws.js";
import { setTradingClient } from "./trading-client.js";
import { loadSchema } from "./proto/codec.js";

/* B9 — choose the copy engine's execution path from EXECUTION_ADAPTER.
 *
 *   atas   (default) → PULL: queue orders for the subscriber's ATAS terminal.
 *   dxfeed           → PUSH: place orders directly on dxFeed prop accounts.
 *
 * For dxfeed we inject a live DxFeedTradingClient behind the adapter. The socket
 * is opened only when COPY_EXECUTION=1 (same master switch that gates all real
 * trading), so selecting the adapter is always safe. Missing trading credentials
 * degrade to a clean "session unavailable" skip, never a bad order. */
export function selectExecutionAdapter(): BrokerAdapter {
  const mode = (process.env.EXECUTION_ADAPTER ?? "atas").toLowerCase();
  if (mode !== "dxfeed") return new PullAdapter("atas");

  if (!dxfeedTradingReady) {
    console.warn(
      "[copy] EXECUTION_ADAPTER=dxfeed but trading credentials are unset — orders will skip as " +
      "'session unavailable'. Set DXFEED_PLTF_KEY / DXFEED_SYSTEM_LOGIN / DXFEED_SYSTEM_PASSWORD.",
    );
  } else {
    const client = new DxFeedTradingClient();
    setTradingClient(client);
    void loadSchema().catch((e) => console.warn("[dxfeed] proto schema load failed:", (e as Error).message));
    if (config.copyExecutionEnabled) {
      console.log("[copy] execution adapter: dxFeed (push) — opening trading session");
      void client.start().catch((e) => console.warn("[dxfeed-trading] start failed:", (e as Error).message));
    } else {
      console.log("[copy] execution adapter: dxFeed (push) — session idle until COPY_EXECUTION=1");
    }
  }
  return new DxFeedAdapter();
}

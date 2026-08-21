import { config } from "../config.js";

/* B3 — Admin Trading API auth.
 *
 * POST the system credential to the auth service; get back a single-use token +
 * the WSS endpoint to open. The docs and the C# example DISAGREE on where the
 * endpoint lives (C# reads a `wss` response HEADER; the v4 PDF says a body field
 * `data.tradingWssEndpoint`) and on the success flag (`status:"OK"` vs
 * `success:true`), so the parse is tolerant of both. Response-parsing is a pure
 * function so it's unit-testable without a live endpoint. */

export interface TradingAuth {
  /** Single-use token for the WSS LoginRequest (also valid for market data). */
  token: string;
  /** wss:// endpoint to open. */
  wssEndpoint: string;
  reportHost?: string;
  reportToken?: string;
}

export function parseAuthResponse(httpOk: boolean, headerWss: string | null, body: any): TradingAuth {
  const success = body?.success === true || body?.status === "OK";
  if (!httpOk || !success) {
    const reason = body?.message || body?.reason || `auth rejected (httpOk=${httpOk})`;
    throw new Error(`dxFeed trading auth: ${reason}`);
  }
  const data = body?.data ?? body;
  const token: string | undefined = data?.tradingWssToken ?? body?.token ?? data?.dataToken;
  // Staging returns the endpoint BOTH as a `wss` response header and as a body
  // field named `tradingWss` (not the `tradingWssEndpoint` the PDF documents).
  // The URL already carries ?token=…&apiVersion=… so it must be used verbatim.
  const wssEndpoint: string | undefined =
    headerWss ?? data?.tradingWss ?? data?.tradingWssEndpoint ?? body?.tradingWssEndpoint;
  if (!token) throw new Error("dxFeed trading auth: no token in response");
  if (!wssEndpoint) throw new Error("dxFeed trading auth: no WSS endpoint in response");
  return {
    token, wssEndpoint,
    reportHost: data?.tradingRestReportHost,
    reportToken: data?.tradingRestReportToken,
  };
}

/** Authenticate with the fullTrading system credential. connectOnlyTrading=true:
 *  a trading-only session (no market data), which also permits concurrent sessions. */
export async function authenticate(): Promise<TradingAuth> {
  const t = config.dxfeed.trading;
  const res = await fetch(t.authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", PltfKey: t.pltfKey },
    body: JSON.stringify({
      login: t.systemLogin,
      password: t.systemPassword,
      environment: config.dxfeed.environment,
      withDetails: true,
      connectOnlyTrading: true,
      version: t.apiVersion,
    }),
  });
  let body: unknown = {};
  try { body = await res.json(); } catch { /* keep {} — parse will surface the failure */ }
  return parseAuthResponse(res.ok, res.headers.get("wss"), body);
}
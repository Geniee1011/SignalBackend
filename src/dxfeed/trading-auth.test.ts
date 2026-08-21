/* B3 test — the auth-response parser handles BOTH documented shapes and the
 * failure cases. Pure function; no network. Run: npx tsx src/dxfeed/trading-auth.test.ts */

import { parseAuthResponse } from "./trading-auth.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};
const throws = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };

// Shape A — C# example: success via status:"OK", token in body, WSS in a header.
{
  const a = parseAuthResponse(true, "wss://trade.staging/ws", { status: "OK", token: "tok-A" });
  check("A: token from body", a.token === "tok-A");
  check("A: endpoint from wss header", a.wssEndpoint === "wss://trade.staging/ws");
}

// Shape B — v4 PDF: success:true, everything under data{}.
{
  const b = parseAuthResponse(true, null, {
    success: true,
    data: { tradingWssToken: "tok-B", tradingWssEndpoint: "wss://trade/ws", tradingRestReportHost: "https://rep", tradingRestReportToken: "rtok" },
  });
  check("B: token from data.tradingWssToken", b.token === "tok-B");
  check("B: endpoint from data.tradingWssEndpoint", b.wssEndpoint === "wss://trade/ws");
  check("B: report host/token carried", b.reportHost === "https://rep" && b.reportToken === "rtok");
}

// Failures.
check("401 rejects", throws(() => parseAuthResponse(false, null, { statusCode: 401, message: "agreements not signed" })));
check("success=false rejects", throws(() => parseAuthResponse(true, null, { success: false, reason: "bad creds" })));
check("missing token rejects", throws(() => parseAuthResponse(true, "wss://x", { status: "OK" })));
check("missing endpoint rejects", throws(() => parseAuthResponse(true, null, { status: "OK", token: "t" })));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
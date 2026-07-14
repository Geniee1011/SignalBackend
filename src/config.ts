import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num("PORT", 8100),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  databaseUrl: process.env.DATABASE_URL?.trim() ?? "",

  jwt: {
    secret: process.env.JWT_SECRET?.trim() || "dev-insecure-signal-secret-change-me",
    expiresInSec: num("JWT_EXPIRES_IN_SEC", 7 * 24 * 60 * 60),
  },

  /** TradingBackend WS feed for real-time relay (optional; polling fallback otherwise). */
  tradingWsUrl: process.env.TRADING_WS_URL?.trim() ?? "",

  /** TradingBackend REST base — the chart proxies its operator-key candle history from here. */
  tradingApiUrl: process.env.TRADING_API_URL?.trim() || "http://localhost:8000",
  /** Shared secret sent to the TradingBackend's /api/market/history (must match its SERVICE_TOKEN). */
  serviceToken: process.env.SERVICE_TOKEN?.trim() ?? "",

  /** Rolling window (hours) of closed signals shown on the Signals page. */
  signalWindowHours: num("SIGNAL_WINDOW_HOURS", 24),
} as const;

if (config.jwt.secret === "dev-insecure-signal-secret-change-me") {
  console.warn("[auth] JWT_SECRET not set — using an insecure dev secret. Set JWT_SECRET in production.");
}

export const useDatabase = config.databaseUrl.length > 0;

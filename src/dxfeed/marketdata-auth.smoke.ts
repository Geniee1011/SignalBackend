import { config } from "../config.js";

/* Can our EXISTING system credential also mint dxFeed MARKET-DATA access?
 *
 * The Admin Trading API book (v1.0, p.2) documents the auth response as carrying
 * market-data credentials alongside the trading ones:
 *     dataEndpoint  — dxLink endpoint ("it can be used any dxFeed technology")
 *     dataToken     — token for dxFeed authentication when opening the connection
 *     dataExchanges — exchanges available to the user
 * and `connectOnlyTrading: true` as "just a session for trading API". We have
 * always sent true, so if that flag is what suppresses the data fields, market
 * data needs no new credential from Volumetrica at all.
 *
 * This matters because Databento went delinquent: with a real dataEndpoint we get
 * full candle history and every symbol back, instead of the public demo feed's
 * four instruments and no history.
 *
 * READ-ONLY: authenticates only. Places no orders and opens no socket.
 * Run: npx tsx src/dxfeed/marketdata-auth.smoke.ts
 */

interface Attempt {
  label: string;
  connectOnlyTrading: boolean;
  withDetails: boolean;
  url?: string;
  /** Defaults to the configured system credential. */
  login?: string;
  password?: string;
}

/* Other credentials worth asking, because market-data entitlement may simply not
 * live on a SYSTEM user. Both are parked commented in .env:
 *  - the per-USER login Volumetrica issued (it has a web platform, so it plausibly
 *    has a data agreement a system credential never signed),
 *  - the VT- pair dxFeed emailed under the subject "credentials for access to
 *    dxFeed market data", which this same endpoint rejects for TRADING. If market
 *    data is what it is for, this is the call that should accept it. */
const PER_USER = { login: "ceasargarrido1011@outlook.com", password: "Fc6%v3Pa" };
const MARKET_DATA = { login: "VT-41bi9x", password: "jeygyFdMkXlNfHzq" };

const ATTEMPTS: Attempt[] = [
  { label: "as we do today (trading only)", connectOnlyTrading: true, withDetails: true },
  { label: "asking for market data too", connectOnlyTrading: false, withDetails: true },
  { label: "market data, no details", connectOnlyTrading: false, withDetails: false },
  {
    label: "market data via the /api/v2 path the book documents",
    connectOnlyTrading: false, withDetails: true,
    url: "https://authdxfeed.volumetricatrading.com/api/v2/auth/token",
  },
  { label: "PER-USER credential, market data", connectOnlyTrading: false, withDetails: true, ...PER_USER },
  { label: "PER-USER credential, trading only (control)", connectOnlyTrading: true, withDetails: true, ...PER_USER },
  { label: "VT- market-data credential, market data", connectOnlyTrading: false, withDetails: true, ...MARKET_DATA },
  { label: "VT- market-data credential, trading only (control)", connectOnlyTrading: true, withDetails: true, ...MARKET_DATA },
];

/** Field names the book uses for the market-data half of the response. */
const DATA_FIELDS = ["dataEndpoint", "dataToken", "dataExchanges"];

function summarise(value: unknown): string {
  if (value == null) return String(value);
  if (Array.isArray(value)) return `[${value.length}] ${JSON.stringify(value).slice(0, 160)}`;
  const s = String(value);
  // Tokens are long and secret — report the shape, never the value.
  return s.length > 40 ? `<${s.length} chars>` : s;
}

async function attempt(a: Attempt): Promise<void> {
  const t = config.dxfeed.trading;
  const url = a.url ?? t.authUrl;
  console.log(`\n--- ${a.label} ---`);
  console.log(`    POST ${url}  connectOnlyTrading=${a.connectOnlyTrading} withDetails=${a.withDetails}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", PltfKey: t.pltfKey },
      body: JSON.stringify({
        login: a.login ?? t.systemLogin,
        password: a.password ?? t.systemPassword,
        environment: config.dxfeed.environment,
        withDetails: a.withDetails,
        connectOnlyTrading: a.connectOnlyTrading,
        version: t.apiVersion,
      }),
    });
  } catch (err) {
    console.log(`    NETWORK ERROR — ${(err as Error).message}`);
    return;
  }

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* reported below */ }
  const data = (body.data ?? body) as Record<string, unknown>;

  console.log(`    HTTP ${res.status}${res.headers.get("wss") ? " (wss header present)" : ""}`);
  if (!res.ok || body.success === false) {
    // The book says the message is the useful part — e.g. "dxFeed's agreements
    // not signed" — and that it should be shown rather than swallowed.
    console.log(`    message: ${String(body.message ?? (text.slice(0, 300) || "(empty body)"))}`);
    return;
  }

  const found = DATA_FIELDS.filter((f) => data[f] != null);
  if (found.length === 0) {
    console.log("    no market-data fields in the response");
  } else {
    console.log("    MARKET DATA PRESENT:");
    for (const f of found) console.log(`      ${f} = ${summarise(data[f])}`);
  }
  const others = Object.keys(data).filter((k) => !DATA_FIELDS.includes(k));
  if (others.length) console.log(`    other fields: ${others.join(", ")}`);
}

async function main(): Promise<void> {
  if (!config.dxfeed.trading.systemLogin || !config.dxfeed.trading.pltfKey) {
    console.error("DXFEED_SYSTEM_LOGIN / DXFEED_PLTF_KEY are not set — nothing to try.");
    process.exit(1);
  }
  console.log("dxFeed market-data credential probe (read-only)");
  console.log(`login: ${config.dxfeed.trading.systemLogin}  environment: ${config.dxfeed.environment}  version: ${config.dxfeed.trading.apiVersion}`);
  for (const a of ATTEMPTS) await attempt(a);
  console.log("\nA dataEndpoint + dataToken above means market data needs no new credential.");
}

main().catch((err) => { console.error("\nprobe failed:", err, "\n"); process.exit(1); });

/* Tradovate REST client.
 *
 * Scope: authenticate, list accounts, resolve a contract, place a bracketed
 * order. No market data — the signal app has its own prices, and Tradovate market
 * data needs separate entitlements.
 *
 * Two Tradovate behaviours drive the design here:
 *
 *  1. Access tokens are short-lived and their auth endpoint is aggressively rate
 *     limited. A 200 response can still be a THROTTLE ("p-ticket"), not a token.
 *     So tokens are cached per link until shortly before expiry and logins are
 *     de-duplicated — never one login per order.
 *  2. Orders are placed against a dated CONTRACT ("ESM6"), not a root ("ES").
 *     Contract lookups are cached briefly; a stale one is how you send an order
 *     to an expired contract. */

const HOSTS = {
  demo: "https://demo.tradovateapi.com/v1",
  live: "https://live.tradovateapi.com/v1",
} as const;

export type TradovateEnv = keyof typeof HOSTS;

const APP_ID = "SignalApp";
const APP_VERSION = "1.0";
const REQUEST_TIMEOUT_MS = 10_000;
/** Renew this long before the token actually expires. */
const TOKEN_SKEW_MS = 60_000;
const CONTRACT_TTL_MS = 10 * 60_000;

export interface TradovateCredentials {
  username: string;
  password: string;
  cid: string;
  sec: string;
  env: TradovateEnv;
}

export interface TradovateAccount {
  id: number;
  name: string;
  nickname?: string;
  accountType?: string;
  active?: boolean;
}

export class TradovateError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "TradovateError";
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokens = new Map<string, CachedToken>();
const logins = new Map<string, Promise<string>>();
const contracts = new Map<string, { id: number; name: string; at: number }>();

/** Cache key for a credential set — never includes the password or secret. */
const keyOf = (c: TradovateCredentials) => `${c.env}:${c.username}:${c.cid}`;

async function request<T>(
  env: TradovateEnv,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = init;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(rest.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${HOSTS[env]}${path}`, {
      ...rest,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Network/timeout — worth retrying, unlike a rejected order.
    throw new TradovateError(`Tradovate unreachable: ${(err as Error).message}`, true);
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new TradovateError(`Tradovate returned non-JSON (${res.status})`);
  }

  if (!res.ok) {
    const msg = (body as { errorText?: string })?.errorText ?? `HTTP ${res.status}`;
    // 429/5xx are transient; 4xx generally means the request itself is wrong.
    throw new TradovateError(`Tradovate: ${msg}`, res.status === 429 || res.status >= 500);
  }
  return body as T;
}

/**
 * Obtain an access token, cached until just before expiry.
 *
 * Tradovate answers a throttled auth request with HTTP 200 and a `p-ticket`
 * instead of a token. Treating that as success would cache an undefined token and
 * fail every later call with a confusing 401, so it is surfaced as a retryable
 * error naming the wait time.
 */
export async function getAccessToken(creds: TradovateCredentials): Promise<string> {
  const key = keyOf(creds);
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.token;

  const existing = logins.get(key);
  if (existing) return existing; // a login is already in flight — share it

  const job = (async () => {
    const body = {
      name: creds.username,
      password: creds.password,
      appId: APP_ID,
      appVersion: APP_VERSION,
      cid: creds.cid,
      sec: creds.sec,
      deviceId: `signal-app-${creds.cid}`,
    };
    const out = await request<{
      accessToken?: string;
      expirationTime?: string;
      errorText?: string;
      "p-ticket"?: string;
      "p-time"?: number;
    }>(creds.env, "/auth/accessTokenRequest", { method: "POST", body: JSON.stringify(body) });

    if (out["p-ticket"]) {
      const wait = out["p-time"] ?? 60;
      throw new TradovateError(`Tradovate is rate limiting logins — retry in ${wait}s`, true);
    }
    if (!out.accessToken) {
      throw new TradovateError(out.errorText ?? "Tradovate rejected the credentials");
    }
    const expiresAt = out.expirationTime ? Date.parse(out.expirationTime) : Date.now() + 60 * 60_000;
    tokens.set(key, { token: out.accessToken, expiresAt });
    return out.accessToken;
  })().finally(() => logins.delete(key));

  logins.set(key, job);
  return job;
}

/** Accounts visible to these credentials. */
export async function listAccounts(creds: TradovateCredentials): Promise<TradovateAccount[]> {
  const token = await getAccessToken(creds);
  const list = await request<TradovateAccount[]>(creds.env, "/account/list", { token });
  return Array.isArray(list) ? list : [];
}

/**
 * Verify credentials and return the account to trade.
 * `preferId` re-selects a previously chosen account across reconnects.
 */
export async function resolveAccount(
  creds: TradovateCredentials,
  preferId?: number | null,
): Promise<TradovateAccount> {
  const accounts = await listAccounts(creds);
  if (accounts.length === 0) throw new TradovateError("No Tradovate accounts found for these credentials");
  if (preferId != null) {
    const match = accounts.find((a) => a.id === preferId);
    if (match) return match;
  }
  // One-to-one phase: prefer the first ACTIVE account, else the first.
  return accounts.find((a) => a.active !== false) ?? accounts[0]!;
}

/* Futures month codes: Jan..Dec = F G H J K M N Q U V X Z.
   Matches the trading platform's `contract-code.ts`. */
const MONTH_CODES = "FGHJKMNQUVXZ";

/**
 * Decode a contract name ("ESU6") into a sortable expiry.
 *
 * The year is a SINGLE digit, so "6" is ambiguous across decades — it is resolved
 * to the nearest year on or after the current one, which is the only reading that
 * can be correct for a tradable contract.
 * Returns null for anything that isn't `<root><monthCode><year>` (spreads,
 * options, micros with different roots), which excludes it from selection.
 */
export function contractExpiry(name: string, root: string, nowMs: number): number | null {
  if (!name.startsWith(root)) return null;
  const tail = name.slice(root.length);
  if (!/^[A-Z]\d$/.test(tail)) return null; // exactly one month code + one year digit
  const monthIdx = MONTH_CODES.indexOf(tail[0]!);
  if (monthIdx < 0) return null;

  const now = new Date(nowMs);
  const currentYear = now.getUTCFullYear();
  const digit = Number(tail[1]);
  // Nearest year >= this one ending in `digit` (e.g. "6" in 2026 → 2026, in 2027 → 2036).
  let year = Math.floor(currentYear / 10) * 10 + digit;
  if (year < currentYear) year += 10;
  return Date.UTC(year, monthIdx, 1);
}

/**
 * Resolve a root ("ES") to Tradovate's current front-month contract ("ESU6").
 *
 * `/contract/suggest` returns matches for a partial name, but in NO useful order:
 * for ES it may return ESH6/ESM6/ESU6/ESZ6, all the same length. Picking the
 * shortest-then-alphabetical name selects ESH6 — an expired March contract — so
 * candidates are decoded to real expiries and the nearest unexpired one wins.
 *
 * A contract in its expiry month is excluded: it may be past last-trade-date, and
 * rolling a month early is far safer than sending an order to a dead contract.
 */
export async function resolveContract(creds: TradovateCredentials, root: string): Promise<{ id: number; name: string }> {
  const cacheKey = `${creds.env}:${root}`;
  const hit = contracts.get(cacheKey);
  if (hit && Date.now() - hit.at < CONTRACT_TTL_MS) return { id: hit.id, name: hit.name };

  const token = await getAccessToken(creds);
  const found = await request<{ id: number; name: string }[]>(
    creds.env,
    `/contract/suggest?t=${encodeURIComponent(root)}&l=20`,
    { token },
  );

  const now = Date.now();
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const candidates = (Array.isArray(found) ? found : [])
    .map((c) => ({ ...c, expiry: typeof c?.name === "string" ? contractExpiry(c.name, root, now) : null }))
    .filter((c): c is { id: number; name: string; expiry: number } => c.expiry != null && c.expiry > monthStart)
    .sort((a, b) => a.expiry - b.expiry);

  const pick = candidates[0];
  if (!pick) throw new TradovateError(`No tradable Tradovate contract found for ${root}`);
  contracts.set(cacheKey, { id: pick.id, name: pick.name, at: Date.now() });
  return { id: pick.id, name: pick.name };
}

export interface PlaceBracketInput {
  account: TradovateAccount;
  contractName: string;
  /** Signal side — LONG buys, SHORT sells. */
  side: "LONG" | "SHORT";
  quantity: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

/**
 * Place a market entry with optional protective bracket, as one OSO
 * (order-sends-order) so the exits are attached atomically. Placing the entry and
 * then the exits separately would leave a naked position if the second call
 * failed — unacceptable on a real account.
 *
 * `isAutomated: true` is required by Tradovate for programmatic orders.
 */
export async function placeBracketOrder(
  creds: TradovateCredentials,
  input: PlaceBracketInput,
): Promise<{ orderId: number }> {
  const token = await getAccessToken(creds);
  const action = input.side === "LONG" ? "Buy" : "Sell";
  const exitAction = input.side === "LONG" ? "Sell" : "Buy";

  const brackets: Record<string, unknown>[] = [];
  if (input.stopLoss != null) {
    brackets.push({
      action: exitAction,
      orderType: "Stop",
      stopPrice: input.stopLoss,
      timeInForce: "GTC",
    });
  }
  if (input.takeProfit != null) {
    brackets.push({
      action: exitAction,
      orderType: "Limit",
      price: input.takeProfit,
      timeInForce: "GTC",
    });
  }

  const payload = {
    accountSpec: input.account.name,
    accountId: input.account.id,
    action,
    symbol: input.contractName,
    orderQty: input.quantity,
    orderType: "Market",
    isAutomated: true,
    ...(brackets.length > 0 ? { bracket1: brackets[0], ...(brackets[1] ? { bracket2: brackets[1] } : {}) } : {}),
  };

  const endpoint = brackets.length > 0 ? "/order/placeOSO" : "/order/placeOrder";
  const out = await request<{ orderId?: number; failureReason?: string; failureText?: string }>(
    creds.env,
    endpoint,
    { method: "POST", token, body: JSON.stringify(payload) },
  );

  if (out.failureReason || out.failureText) {
    throw new TradovateError(`Order rejected: ${out.failureText ?? out.failureReason}`);
  }
  if (out.orderId == null) throw new TradovateError("Tradovate accepted the request but returned no order id");
  return { orderId: out.orderId };
}

/** Drop cached auth for a link (used on disconnect / credential change). */
export function forgetCredentials(creds: TradovateCredentials): void {
  tokens.delete(keyOf(creds));
}

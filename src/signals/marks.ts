import { config } from "../config.js";

/* Live mark prices for open signals.
 *
 * The TradingApp admin Positions page marks every open lot to market against the
 * live quote feed — the stored `Position.unrealizedPnl` column is a stale snapshot.
 * For the signal feed to be the exact mirror of that page, we need the same live
 * mark. The SignalBackend has no Databento key of its own, so it borrows the
 * TradingBackend's operator-key candle endpoint (the same one the chart proxies)
 * and reads the most recent 1-minute close.
 *
 * Cached for MARK_TTL_MS so a 1s broadcast tick doesn't hammer the upstream. */

const MARK_TTL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 4_000;

interface Entry {
  price: number;
  at: number;
}

const cache = new Map<string, Entry>();
/** In-flight fetches, so N concurrent callers for one symbol share a single request. */
const inflight = new Map<string, Promise<number | undefined>>();

/* Contract point value in USD.
 *
 * The AUTHORITATIVE value ships alongside each mark from the trading backend, so
 * the two services can never disagree about how a point converts to dollars. This
 * table is only a cold-start fallback for the candle path (used before any marks
 * response has been seen); if it ever drifts from the trading backend's
 * `instruments.ts`, the upstream value still wins. */
const FALLBACK_MULTIPLIER: Record<string, number> = {
  ES: 50, MES: 5,
  NQ: 20, MNQ: 2,
  YM: 5, MYM: 0.5,
  CL: 1000, MCL: 100,
  GC: 100, MGC: 10,
};

/** Multipliers learned from the trading backend — the source of truth. */
const upstreamMultiplier = new Map<string, number>();

export function getMultiplier(symbol: string): number {
  return upstreamMultiplier.get(symbol) ?? FALLBACK_MULTIPLIER[symbol] ?? 1;
}

/** Warn once per reason, so a persistent outage doesn't spam the log every tick. */
const warned = new Set<string>();
function warnOnce(key: string, msg: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[marks] ${msg}`);
}

/**
 * Batch live marks from the TradingBackend's quote map — the exact source the
 * admin Positions page marks against. One request covers every symbol.
 * Returns an empty map (not a throw) when the upstream is unreachable.
 */
async function fetchLiveMarks(symbols: string[]): Promise<Map<string, number>> {
  const headers: Record<string, string> = {};
  if (config.serviceToken) headers["x-service-token"] = config.serviceToken;
  const url = `${config.tradingApiUrl}/api/market/marks?symbols=${encodeURIComponent(symbols.join(","))}`;
  const out = new Map<string, number>();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      warnOnce(`status:${res.status}`, `trading backend returned ${res.status} for /api/market/marks — open P&L will fall back to candles/stored values`);
      return out;
    }
    const data = (await res.json()) as Record<string, { mark?: unknown; multiplier?: unknown }>;
    for (const [symbol, entry] of Object.entries(data ?? {})) {
      const price = Number(entry?.mark);
      if (Number.isFinite(price) && price > 0) out.set(symbol, price);
      const mult = Number(entry?.multiplier);
      if (Number.isFinite(mult) && mult > 0) upstreamMultiplier.set(symbol, mult);
    }
    warned.clear(); // recovered
  } catch (err) {
    warnOnce("unreachable", `cannot reach ${config.tradingApiUrl} (${(err as Error).message}) — is the trading backend running and TRADING_API_URL correct?`);
  }
  return out;
}

async function fetchMark(symbol: string): Promise<number | undefined> {
  const headers: Record<string, string> = {};
  if (config.serviceToken) headers["x-service-token"] = config.serviceToken;
  const url = `${config.tradingApiUrl}/api/market/history?symbol=${encodeURIComponent(symbol)}&resolution=60&count=1`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { close?: unknown }[] | unknown;
    if (!Array.isArray(data) || data.length === 0) return undefined;
    const close = Number(data[data.length - 1]?.close);
    return Number.isFinite(close) && close > 0 ? close : undefined;
  } catch {
    return undefined; // upstream down / no key — caller falls back to the stored mark
  }
}

/**
 * Mark prices for the given symbols. Never throws: a symbol the upstream can't
 * price is simply absent from the map, and the caller keeps its stored P&L.
 */
export async function getMarks(symbols: string[]): Promise<Map<string, number>> {
  const now = Date.now();
  const wanted = [...new Set(symbols)];
  const out = new Map<string, number>();
  const pending: Promise<void>[] = [];

  // Anything still fresh in cache needs no upstream call at all.
  const stale = wanted.filter((s) => {
    const hit = cache.get(s);
    if (hit && now - hit.at < MARK_TTL_MS) { out.set(s, hit.price); return false; }
    return true;
  });

  // Preferred path: one batch call for the live quotes the admin page uses.
  if (stale.length > 0) {
    const live = await fetchLiveMarks(stale);
    for (const [symbol, price] of live) {
      cache.set(symbol, { price, at: Date.now() });
      out.set(symbol, price);
    }
  }

  // Fallback for anything the quote map couldn't price (feed not warmed up for
  // that symbol yet): derive it from the most recent 1-minute candle.
  for (const symbol of stale) {
    if (out.has(symbol)) continue;
    const hit = cache.get(symbol);
    let job = inflight.get(symbol);
    if (!job) {
      job = fetchMark(symbol).finally(() => inflight.delete(symbol));
      inflight.set(symbol, job);
    }
    pending.push(
      job.then((price) => {
        if (price != null) {
          cache.set(symbol, { price, at: Date.now() });
          out.set(symbol, price);
        } else if (hit) {
          out.set(symbol, hit.price); // serve stale rather than nothing
        }
      }),
    );
  }

  await Promise.all(pending);
  return out;
}

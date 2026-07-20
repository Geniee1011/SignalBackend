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

/** Contract point value in USD — mirrors TradingBackend's `instruments.ts`. */
const MULTIPLIER: Record<string, number> = {
  ES: 50, MES: 5,
  NQ: 20, MNQ: 2,
  YM: 5, MYM: 0.5,
  CL: 1000, MCL: 100,
  GC: 100, MGC: 10,
};

export function getMultiplier(symbol: string): number {
  return MULTIPLIER[symbol] ?? 1;
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

  for (const symbol of wanted) {
    const hit = cache.get(symbol);
    if (hit && now - hit.at < MARK_TTL_MS) {
      out.set(symbol, hit.price);
      continue;
    }
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

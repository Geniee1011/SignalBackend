import { propfirm } from "./propfirm.js";
import type { DxSymbol } from "./types.js";

/* Resolve our root symbols (as signals carry them — "MES", "NQ") to dxFeed's
 * tradeable instruments. The Admin Trading API references instruments by dxFeed's
 * id, so this is the bridge the order path needs.
 *
 * The list is small and stable, so it's cached for an hour. Our sizing already
 * picks the MICRO symbol (sizing.ts), and every micro/mini we use is present in
 * dxFeed's list, so a straight name match is enough. */

let cache: Map<string, DxSymbol> | null = null;
let fetchedAt = 0;
const TTL_MS = 60 * 60 * 1000;

/** dxFeed's list mixes futures with stocks, and some stock tickers COLLIDE with
 *  futures roots (e.g. a stock "MGC" vs Micro Gold "MGC"). We only ever trade
 *  futures, so index futures only — otherwise a stock can shadow the real
 *  contract and we'd size against a $0 tick value. */
const isFuture = (s: DxSymbol): boolean =>
  s.category === "FUTURE" || (s.symbolGroup?.toUpperCase().startsWith("FUTURE") ?? false);

async function load(): Promise<Map<string, DxSymbol>> {
  if (cache && Date.now() - fetchedAt < TTL_MS) return cache;
  const list = await propfirm.getSymbolList();
  const m = new Map<string, DxSymbol>();
  for (const s of list) {
    if (!isFuture(s)) continue;
    m.set(s.name.toUpperCase(), s);
  }
  cache = m;
  fetchedAt = Date.now();
  return m;
}

/** The dxFeed instrument for a root symbol, or null if it isn't tradeable there. */
export async function resolveSymbol(root: string): Promise<DxSymbol | null> {
  return (await load()).get(root.toUpperCase()) ?? null;
}

/** dxFeed instrument id for a root symbol (what an order references), or null. */
export async function dxSymbolId(root: string): Promise<number | null> {
  return (await resolveSymbol(root))?.id ?? null;
}

/** Force a refresh on the next lookup (e.g. after dxFeed changes the symbol set). */
export function clearSymbolCache(): void {
  cache = null;
}

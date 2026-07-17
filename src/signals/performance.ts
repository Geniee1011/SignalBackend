import { getClosedSignals, type Signal } from "./source.js";
import type { AccessConfig } from "../access/access.js";

/* Performance stats for the signal flow — computed from CLOSED signals (the
 * counter side). Mirrors the TradingApp analytics: win/loss, by-market breakdown,
 * cumulative shadow P&L, and max drawdown of that curve. */

const round2 = (n: number) => Math.round(n * 100) / 100;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

export interface PerformanceFilters {
  sinceMs?: number;
  untilMs?: number; // inclusive upper bound; undefined = up to now
  market?: string; // filter to one market (e.g. "ES"); undefined = all
  access?: AccessConfig; // the subscriber's entitlements — track record is scoped to it
}

/** Restrict a closed-signal set to what the subscriber's access covers (markets /
 *  direction / conviction). The daily limit and live toggle don't apply to a
 *  historical track record. A suspended user sees nothing. */
function scopeToAccess(closed: Signal[], access: AccessConfig): Signal[] {
  if (access.suspended) return [];
  return closed.filter((s) => {
    if (access.markets.length && !access.markets.includes(s.market)) return false;
    if (access.direction !== "BOTH" && s.side !== access.direction) return false;
    if ((s.conviction || 1) < access.minConviction) return false;
    return true;
  });
}

export interface Performance {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number; // 0-100
  totalPnl: number;
  maxDrawdown: number; // positive magnitude
  profitFactor: number; // gross profit / gross loss
  avgRR: number; // avg win $ / avg loss $ (reward-to-risk)
  avgWin: number;
  avgLoss: number; // positive magnitude
  byMarket: { market: string; n: number; winRate: number; pnl: number }[];
  equityCurve: { day: string; value: number }[]; // cumulative signal P&L
  recent: Signal[];
}

export async function getPerformance(filters: PerformanceFilters = {}): Promise<Performance> {
  const since = filters.sinceMs ?? Date.now() - 90 * 86_400_000; // default: last 90 days
  let closed = await getClosedSignals(since, filters.untilMs);
  if (filters.market) closed = closed.filter((s) => s.market === filters.market);
  if (filters.access) closed = scopeToAccess(closed, filters.access);

  const decided = closed.filter((s) => s.win !== null); // exclude breakeven from win rate
  const wins = decided.filter((s) => s.win).length;
  const losses = decided.length - wins;
  const totalPnl = round2(closed.reduce((a, s) => a + (s.pnl ?? 0), 0));

  // Profit factor + reward-to-risk from realized P&L.
  const winPnls = closed.filter((s) => (s.pnl ?? 0) > 0).map((s) => s.pnl!);
  const lossPnls = closed.filter((s) => (s.pnl ?? 0) < 0).map((s) => s.pnl!);
  const grossProfit = winPnls.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossPnls.reduce((a, b) => a + b, 0));
  const avgWin = winPnls.length ? grossProfit / winPnls.length : 0;
  const avgLoss = lossPnls.length ? grossLoss / lossPnls.length : 0;
  const profitFactor = grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? grossProfit : 0;
  const avgRR = avgLoss > 0 ? round2(avgWin / avgLoss) : 0;

  // By market.
  const byMarketMap = new Map<string, { n: number; wins: number; decided: number; pnl: number }>();
  for (const s of closed) {
    const e = byMarketMap.get(s.market) ?? { n: 0, wins: 0, decided: 0, pnl: 0 };
    e.n++; e.pnl += s.pnl ?? 0;
    if (s.win !== null) { e.decided++; if (s.win) e.wins++; }
    byMarketMap.set(s.market, e);
  }
  const byMarket = [...byMarketMap.entries()]
    .map(([mkt, e]) => ({ market: mkt, n: e.n, winRate: e.decided ? round2((e.wins / e.decided) * 100) : 0, pnl: round2(e.pnl) }))
    .sort((a, b) => b.n - a.n);

  // Cumulative shadow P&L by day (oldest → newest) + max drawdown of that curve.
  const byDay = new Map<string, number>();
  for (const s of closed) if (s.closedAt != null) byDay.set(dayKey(s.closedAt), (byDay.get(dayKey(s.closedAt)) ?? 0) + (s.pnl ?? 0));
  let cum = 0, peak = 0, maxDd = 0;
  const equityCurve = [...byDay.keys()].sort().map((day) => {
    cum += byDay.get(day)!;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    return { day, value: round2(cum) };
  });

  return {
    totalTrades: closed.length,
    wins,
    losses,
    winRate: decided.length ? round2((wins / decided.length) * 100) : 0,
    totalPnl,
    maxDrawdown: round2(maxDd),
    profitFactor,
    avgRR,
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    byMarket,
    equityCurve,
    recent: closed.slice(0, 100),
  };
}

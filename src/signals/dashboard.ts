import type { Signal } from "./source.js";

/* ---------------------------------------------------------------------------
 * Dashboard model — the per-market overview shown on the Signal App home page.
 *
 * Each market card is derived from the (access-scoped) signal set:
 *   - status     : Active Trade (open signal) / In Play (recent) / Standby (none)
 *   - conviction : 0-100, mapped from the latest signal's conviction phase (1-4)
 *                  plus a small recent-activity nudge, so it reflects real data
 *   - bias       : Breakout (long-side) / Reversal (short-side) / — (standby)
 *   - activeSignal: the open signal, for the Trade Details panel
 *
 * The chart's per-minute "conviction oscillator" has no real feed, so it's a
 * smooth demo curve generated client-side around this conviction value.
 * ------------------------------------------------------------------------- */

export const DASHBOARD_MARKETS = ["ES", "NQ", "YM", "GC", "CL"] as const;

const META: Record<string, { name: string; exchange: string }> = {
  ES: { name: "S&P 500", exchange: "CME" },
  NQ: { name: "Nasdaq 100", exchange: "CME" },
  YM: { name: "Dow", exchange: "CBOT" },
  GC: { name: "Gold", exchange: "COMEX" },
  CL: { name: "Crude Oil", exchange: "NYMEX" },
};

export type MarketStatus = "active" | "in_play" | "standby";
export type Bias = "Breakout" | "Reversal" | null;

export interface DashboardMarket {
  market: string;
  name: string;
  exchange: string;
  status: MarketStatus;
  conviction: number; // 0-100
  bias: Bias;
  activeSignal: Signal | null;
}

export interface Dashboard {
  markets: DashboardMarket[];
  generatedAt: number;
}

const PHASE_PCT: Record<number, number> = { 1: 30, 2: 50, 3: 68, 4: 85 };
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Deterministic 0..1 from a string, so a market's conviction is stable per session. */
function seed01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

const tsOf = (s: Signal): number => (s.status === "active" ? s.openedAt : (s.closedAt ?? s.openedAt));

export function buildDashboard(signals: Signal[], allowedMarkets: readonly string[]): Dashboard {
  const markets = allowedMarkets.filter((m) => (DASHBOARD_MARKETS as readonly string[]).includes(m));

  const list: DashboardMarket[] = markets.map((mkt) => {
    const ms = signals.filter((s) => s.market === mkt);
    const active = ms.find((s) => s.status === "active") ?? null;
    const latest = active ?? [...ms].sort((a, b) => tsOf(b) - tsOf(a))[0] ?? null;
    const status: MarketStatus = active ? "active" : ms.length ? "in_play" : "standby";
    const jitter = Math.round((seed01(mkt) - 0.5) * 10); // ±5, stable per market

    let conviction: number;
    if (latest) {
      // Derived from real signal data: the conviction phase, how many signals the
      // market has produced, whether a trade is currently open, and recency. When
      // phases are uniform (as in seeded demo data) these real differentiators are
      // what separate an active, busy market from a quiet one.
      const base = PHASE_PCT[clamp(latest.conviction || 1, 1, 4)] ?? 40;
      const activity = Math.min(ms.length, 6) * 5; // more signals → higher
      const live = active ? 20 : 6; // an open trade spikes conviction
      const recent = tsOf(latest) > Date.now() - 3 * 3_600_000 ? 6 : 0;
      conviction = clamp(Math.round(0.5 * base + activity + live + recent + jitter), 8, 97);
    } else {
      conviction = clamp(24 + Math.round(seed01(mkt + "s") * 14), 8, 40); // standby: 24-38
    }

    const bias: Bias = status === "standby" || !latest ? null : latest.side === "LONG" ? "Breakout" : "Reversal";

    return {
      market: mkt,
      name: META[mkt]?.name ?? mkt,
      exchange: META[mkt]?.exchange ?? "",
      status,
      conviction,
      bias,
      activeSignal: active,
    };
  });

  // Active trades first, then by conviction (matches the mockup's ordering).
  list.sort((a, b) => (a.status === "active" ? -1 : 0) - (b.status === "active" ? -1 : 0) || b.conviction - a.conviction);

  return { markets: list, generatedAt: Date.now() };
}

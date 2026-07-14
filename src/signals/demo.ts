import { getPool } from "../db/pool.js";
import type { Signal } from "./source.js";

/* ---------------------------------------------------------------------------
 * DEMO signals — DESIGN-DEMO fallback only.
 *
 * When the trading platform has NO live trades in the requested window (e.g. a
 * fresh clone, or a seed whose trades are older than 24h), the Signals page and
 * the chart markers would be empty. This re-bases the most recent REAL closed
 * trades into the recent window so the design is presentable — a couple promoted
 * to "active" so the Open stat and highlighted rows show.
 *
 * It reuses the REAL trades' prices, P&L, and conviction (only timestamps are
 * shifted), so it stays coherent with the Performance page. Reads trades
 * READ-ONLY; writes nothing to any table.
 *
 * Easy to reverse — self-reverses the moment real trades land in the window
 * (the fallback branch in getSignals() only fires when the live set is empty).
 * Otherwise: set DEMO_SIGNALS=0, or delete this file + that branch.
 * ------------------------------------------------------------------------- */

export const demoSignalsEnabled = process.env.DEMO_SIGNALS !== "0";

const PARENT: Record<string, string> = { MES: "ES", MNQ: "NQ", MGC: "GC", MCL: "CL", MYM: "YM" };
const market = (s: string): string => PARENT[s] ?? s;
const invert = (side: string): "LONG" | "SHORT" => (side === "LONG" ? "SHORT" : "LONG");
const num = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

const ACTIVE_COUNT = 2; // newest real trades shown as still-open signals
const CLOSED_SPAN_MS = 20 * 3_600_000; // closed demo signals spread across the last 20h
const ACTIVE_SPAN_MS = 2.5 * 3_600_000; // open demo signals opened within the last ~2.5h
const NEWEST_CLOSED_MS = 3_600_000; // most-recent closed signal sits ~1h ago
const MAX_DURATION_MS = 45 * 60_000; // cap a signal's open→close span for tidy markers

/**
 * Build a presentable set of demo signals from the most recent real closed
 * positions, timestamps re-based into the recent window. `windowHours` bounds the
 * closed set (active signals are always shown).
 */
export async function buildDemoSignals(windowHours: number): Promise<Signal[]> {
  const { rows } = await getPool().query(
    `SELECT "id","symbol","side","quantity","entryPrice","exitPrice","realizedPnl","openedAt","closedAt","phaseAtOpen"
     FROM "public"."ClosedPosition" ORDER BY "closedAt" DESC LIMIT 24`,
  );
  if (rows.length === 0) return [];

  // Quantize "now" to the minute so repeated 3s WS polls don't jitter the markers
  // or flip a signal between active and closed mid-demo.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const active: Signal[] = [];
  const closed: Signal[] = [];
  const nClosed = Math.max(1, rows.length - ACTIVE_COUNT);

  rows.forEach((r, i) => {
    const entry = num(r.entryPrice);
    const exit = num(r.exitPrice);
    const sig = invert(r.side);
    const conviction = (r.phaseAtOpen != null ? num(r.phaseAtOpen) : 1) || 1;

    if (i < ACTIVE_COUNT) {
      // Open signal: opened within the last ACTIVE_SPAN, with a synthesized bracket.
      const openedAt = now - Math.round(((i + 1) / (ACTIVE_COUNT + 1)) * ACTIVE_SPAN_MS);
      const risk = Math.max(Math.abs(entry - exit), entry * 0.0015) || entry * 0.0015;
      // Signal SHORT → stop above / target below entry; LONG → mirror.
      const sl = sig === "SHORT" ? entry + risk : entry - risk;
      const tp = sig === "SHORT" ? entry - risk * 2 : entry + risk * 2;
      active.push({
        id: `demo-pos:${r.id}`,
        symbol: r.symbol,
        market: market(r.symbol),
        side: sig,
        entry,
        stopLoss: round2(sl),
        takeProfit: round2(tp),
        exit: null,
        quantity: num(r.quantity),
        conviction,
        status: "active",
        openedAt,
        closedAt: null,
        pnl: null,
        unrealizedPnl: round2(-num(r.realizedPnl)), // open signal P&L = opposite of trader's
        win: null,
      });
    } else {
      // Closed signal: spaced from ~1h ago (newest) back to ~20h ago (oldest).
      const ci = i - ACTIVE_COUNT;
      const closedAt =
        now - NEWEST_CLOSED_MS - Math.round((ci / Math.max(1, nClosed - 1)) * (CLOSED_SPAN_MS - NEWEST_CLOSED_MS));
      const realDur =
        r.closedAt && r.openedAt ? new Date(r.closedAt).getTime() - new Date(r.openedAt).getTime() : 0;
      const openedAt = closedAt - Math.min(Math.max(60_000, realDur || 15 * 60_000), MAX_DURATION_MS);
      const signalPnl = -num(r.realizedPnl);
      closed.push({
        id: `demo-cls:${r.id}`,
        symbol: r.symbol,
        market: market(r.symbol),
        side: sig,
        entry,
        stopLoss: null,
        takeProfit: null,
        exit,
        quantity: num(r.quantity),
        conviction,
        status: "closed",
        openedAt,
        closedAt,
        pnl: round2(signalPnl),
        unrealizedPnl: null,
        win: Math.abs(signalPnl) < 0.005 ? null : signalPnl > 0,
      });
    }
  });

  const since = now - windowHours * 3_600_000;
  const closedInWindow = closed.filter((s) => (s.closedAt ?? 0) >= since);
  return [...active, ...closedInWindow];
}

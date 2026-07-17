import { getPool } from "../db/pool.js";
import type { Signal } from "./source.js";

/* ---------------------------------------------------------------------------
 * DEMO signals — DESIGN-DEMO fallback only.
 *
 * When the trading platform has NO live trades in the requested window, the
 * Signals page and the chart would be empty. This synthesizes a plausible history
 * by cycling the most recent REAL closed trades as templates and spreading them
 * across the last DEMO_DAYS — so any date the calendar can pick has data, while
 * the last 24h stays as dense as before.
 *
 * It reuses the REAL trades' prices, P&L and conviction (only timestamps are
 * synthesized). Reads trades READ-ONLY; writes nothing.
 *
 * Easy to reverse — self-reverses the moment real trades land in the window (the
 * fallback only fires on an empty live set). Otherwise: DEMO_SIGNALS=0, or delete
 * this file + the fallback branch in getSignalsRange().
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

const DAY_MS = 86_400_000;
const DEMO_DAYS = 30; // how far back the synthesized history reaches
const PER_DAY = 8; // closed signals per rolling 24h bucket
const ACTIVE_COUNT = 2; // newest real trades presented as still-open signals
const ACTIVE_SPAN_MS = 2.5 * 3_600_000;
const MAX_DURATION_MS = 45 * 60_000; // cap a signal's open→close span

interface TemplateRow {
  id: string;
  symbol: string;
  side: string;
  quantity: unknown;
  entryPrice: unknown;
  exitPrice: unknown;
  realizedPnl: unknown;
  openedAt: string;
  closedAt: string;
  phaseAtOpen: unknown;
}

async function templates(): Promise<TemplateRow[]> {
  const { rows } = await getPool().query(
    `SELECT "id","symbol","side","quantity","entryPrice","exitPrice","realizedPnl","openedAt","closedAt","phaseAtOpen"
     FROM "public"."ClosedPosition" ORDER BY "closedAt" DESC LIMIT 24`,
  );
  return rows as TemplateRow[];
}

const conviction = (r: TemplateRow): number => (r.phaseAtOpen != null ? num(r.phaseAtOpen) : 1) || 1;

/**
 * Build demo signals whose timestamps fall inside [sinceMs, untilMs]. `untilMs`
 * defaults to now. Deterministic: the same window always yields the same set.
 */
export async function buildDemoSignals(sinceMs: number, untilMs?: number): Promise<Signal[]> {
  const rows = await templates();
  if (rows.length === 0) return [];

  // Quantize "now" to the minute so repeated polls don't jitter the set.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const until = untilMs ?? now;
  const out: Signal[] = [];

  // Open signals — only when the window actually reaches the present.
  for (let i = 0; i < Math.min(ACTIVE_COUNT, rows.length); i++) {
    const r = rows[i]!;
    const openedAt = now - Math.round(((i + 1) / (ACTIVE_COUNT + 1)) * ACTIVE_SPAN_MS);
    if (openedAt < sinceMs || openedAt > until) continue;
    const entry = num(r.entryPrice);
    const exit = num(r.exitPrice);
    const sig = invert(r.side);
    const risk = Math.max(Math.abs(entry - exit), entry * 0.0015) || entry * 0.0015;
    out.push({
      id: `demo-pos:${r.id}`,
      symbol: r.symbol,
      market: market(r.symbol),
      side: sig,
      entry,
      stopLoss: round2(sig === "SHORT" ? entry + risk : entry - risk),
      takeProfit: round2(sig === "SHORT" ? entry - risk * 2 : entry + risk * 2),
      exit: null,
      quantity: num(r.quantity),
      conviction: conviction(r),
      status: "active",
      openedAt,
      closedAt: null,
      pnl: null,
      unrealizedPnl: round2(-num(r.realizedPnl)), // open signal P&L = opposite of trader's
      win: null,
    });
  }

  // Closed signals — PER_DAY per rolling 24h bucket, back DEMO_DAYS, cycling the
  // real trades as templates so every pickable date has plausible history.
  for (let d = 0; d < DEMO_DAYS; d++) {
    const bucketEnd = now - d * DAY_MS;
    for (let k = 0; k < PER_DAY; k++) {
      const closedAt = bucketEnd - Math.round(((k + 1) / (PER_DAY + 1)) * DAY_MS);
      if (closedAt < sinceMs || closedAt > until) continue;
      const r = rows[(d * PER_DAY + k) % rows.length]!;
      const realDur = r.closedAt && r.openedAt ? new Date(r.closedAt).getTime() - new Date(r.openedAt).getTime() : 0;
      const openedAt = closedAt - Math.min(Math.max(60_000, realDur || 15 * 60_000), MAX_DURATION_MS);
      const signalPnl = -num(r.realizedPnl);
      out.push({
        id: `demo-cls:${r.id}:${d}:${k}`,
        symbol: r.symbol,
        market: market(r.symbol),
        side: invert(r.side),
        entry: num(r.entryPrice),
        stopLoss: null,
        takeProfit: null,
        exit: num(r.exitPrice),
        quantity: num(r.quantity),
        conviction: conviction(r),
        status: "closed",
        openedAt,
        closedAt,
        pnl: round2(signalPnl),
        unrealizedPnl: null,
        win: Math.abs(signalPnl) < 0.005 ? null : signalPnl > 0,
      });
    }
  }

  return out;
}

import { getPool } from "../db/pool.js";
import { config } from "../config.js";
import { buildDemoSignals, demoSignalsEnabled } from "./demo.js";

/* Signal source — the core of the product. Reads the trading platform's trades
 * (READ-ONLY, from public.*) and turns each into a COUNTER signal:
 *   - direction is inverted     (trader LONG  → signal SHORT)
 *   - stop-loss / take-profit swap sides (signal SL = trader TP, signal TP = trader SL)
 *   - exit mirrors the trader's close
 *   - P&L is the opposite of the trader's realized P&L (the "shadow" P&L)
 *   - conviction = the trader's risk phase (1-4)
 *
 * Never writes to the trading tables. */

const num = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Micro → parent root, so "by market" stats roll micros into their parent. */
const PARENT: Record<string, string> = { MES: "ES", MNQ: "NQ", MGC: "GC", MCL: "CL", MYM: "YM" };
export const market = (symbol: string): string => PARENT[symbol] ?? symbol;

/** Flip a trading side to the signal (counter) side. */
const invert = (side: string): "LONG" | "SHORT" => (side === "LONG" ? "SHORT" : "LONG");

export interface Signal {
  id: string;
  symbol: string;
  market: string;
  side: "LONG" | "SHORT"; // signal (inverted) side
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  exit: number | null;
  quantity: number;
  conviction: number; // trader risk phase 1-4
  status: "active" | "closed";
  openedAt: number;
  closedAt: number | null;
  pnl: number | null; // signal realized P&L (closed only) = -trader realized
  unrealizedPnl: number | null; // signal open P&L (active only) = -trader unrealized
  win: boolean | null;
  locked?: boolean; // over the user's daily limit — price levels hidden (upsell)
}

/**
 * Live SL/TP per (account, symbol) from the trader's resting bracket legs:
 * a PENDING STOP order is the trader's stop-loss, a PENDING LIMIT its take-profit.
 * Returns the TRADER's levels (caller swaps them for the inverted signal).
 */
async function bracketLevels(): Promise<Map<string, { sl: number | null; tp: number | null }>> {
  const { rows } = await getPool().query(
    `SELECT "accountId","symbol","type","stopPrice","requestedPrice"
     FROM "public"."Order"
     WHERE "status" = 'PENDING' AND "ocoGroupId" IS NOT NULL`,
  );
  const map = new Map<string, { sl: number | null; tp: number | null }>();
  for (const r of rows) {
    const key = `${r.accountId}|${r.symbol}`;
    const e = map.get(key) ?? { sl: null, tp: null };
    if (r.type === "STOP" || r.type === "STOP_LIMIT") e.sl = r.stopPrice != null ? num(r.stopPrice) : e.sl;
    else if (r.type === "LIMIT") e.tp = r.requestedPrice != null ? num(r.requestedPrice) : e.tp;
    map.set(key, e);
  }
  return map;
}

/** Active signals — one per open position on the trading platform, inverted. */
export async function getActiveSignals(): Promise<Signal[]> {
  const [{ rows }, brackets] = await Promise.all([
    getPool().query(
      `SELECT p."id", p."accountId", p."symbol", p."side", p."quantity", p."averagePrice", p."openedAt",
              p."unrealizedPnl", COALESCE(a."riskPhase", 1) AS "riskPhase"
       FROM "public"."Position" p JOIN "public"."Account" a ON a."id" = p."accountId"
       ORDER BY p."openedAt" DESC`,
    ),
    bracketLevels(),
  ]);
  return rows.map((r) => {
    const traderLevels = brackets.get(`${r.accountId}|${r.symbol}`) ?? { sl: null, tp: null };
    return {
      id: `pos:${r.id}`,
      symbol: r.symbol,
      market: market(r.symbol),
      side: invert(r.side),
      entry: num(r.averagePrice),
      // Inverted: the signal's stop is where the trader would take profit, and vice versa.
      stopLoss: traderLevels.tp,
      takeProfit: traderLevels.sl,
      exit: null,
      quantity: num(r.quantity),
      conviction: num(r.riskPhase) || 1,
      status: "active" as const,
      openedAt: new Date(r.openedAt).getTime(),
      closedAt: null,
      pnl: null,
      // Signal open P&L is the opposite of the trader's unrealized P&L.
      unrealizedPnl: Math.round(-num(r.unrealizedPnl) * 100) / 100,
      win: null,
    };
  });
}

/** Closed signals within a window — inverted, with signal-side P&L.
 *  `untilMs` is inclusive; omit it for "up to now". */
export async function getClosedSignals(sinceMs: number, untilMs?: number): Promise<Signal[]> {
  const { rows } = await getPool().query(
    `SELECT "id","symbol","side","quantity","entryPrice","exitPrice","realizedPnl","openedAt","closedAt","phaseAtOpen"
     FROM "public"."ClosedPosition"
     WHERE "closedAt" >= $1 AND ($2::timestamptz IS NULL OR "closedAt" <= $2)
     ORDER BY "closedAt" DESC`,
    [new Date(sinceMs), untilMs != null ? new Date(untilMs) : null],
  );
  return rows.map((r) => {
    const signalPnl = -num(r.realizedPnl); // counter side
    return {
      id: `cls:${r.id}`,
      symbol: r.symbol,
      market: market(r.symbol),
      side: invert(r.side),
      entry: num(r.entryPrice),
      stopLoss: null, // historical bracket levels aren't retained on the closed row
      takeProfit: null,
      exit: num(r.exitPrice),
      quantity: num(r.quantity),
      conviction: r.phaseAtOpen != null ? num(r.phaseAtOpen) : 1,
      status: "closed" as const,
      openedAt: new Date(r.openedAt).getTime(),
      closedAt: new Date(r.closedAt).getTime(),
      pnl: Math.round(signalPnl * 100) / 100,
      unrealizedPnl: null,
      win: Math.abs(signalPnl) < 0.005 ? null : signalPnl > 0,
    };
  });
}

/**
 * Active + closed signals within an explicit window. `untilMs` is inclusive;
 * omit it for "up to now". Open signals are included when they were opened inside
 * the window, so a past range shows what was running at the time.
 */
export async function getSignalsRange(sinceMs: number, untilMs?: number): Promise<Signal[]> {
  const [activeAll, closed] = await Promise.all([getActiveSignals(), getClosedSignals(sinceMs, untilMs)]);
  const active = activeAll.filter((s) => s.openedAt >= sinceMs && (untilMs == null || s.openedAt <= untilMs));
  // Design-demo fallback: when there are no live trades in the window, synthesize a
  // plausible set so the page/chart aren't empty. Real data always wins — this only
  // fires on a truly empty live set.
  if (active.length === 0 && closed.length === 0 && demoSignalsEnabled) {
    return buildDemoSignals(sinceMs, untilMs);
  }
  // Active first, then closed newest-first.
  return [...active, ...closed];
}

/** Active + recent-closed signals for the Signals page (last N hours). */
export async function getSignals(windowHours = config.signalWindowHours): Promise<Signal[]> {
  return getSignalsRange(Date.now() - windowHours * 3_600_000);
}

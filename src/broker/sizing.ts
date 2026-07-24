import { getMultiplier } from "../signals/marks.js";
import type { Signal } from "../signals/source.js";

/* Position sizing by target dollar risk.
 *
 * A signal is copied at a size that risks a FIXED dollar amount — set per
 * conviction level in the admin risk config — not at the trader's contract count.
 * A trader might risk $400 on one E-mini; if that signal is level-1 conviction and
 * our level-1 risk is $100, copying the mini 1:1 would risk 4x what we intend.
 *
 * To hit small targets precisely we size in MICRO contracts (1/10 of the mini),
 * whose finer point value gives fine-grained risk steps:
 *
 *   risk per contract = |entry - stop| x point-value(symbol)
 *   contracts         = round( targetRisk / riskPerContract ), minimum 1
 *
 * Rounding is to NEAREST (so the realized risk sits closest to the target, which
 * may be a little over or under), with a floor of 1 so a fractional result never
 * drops the trade. Prices are identical for a mini and its micro — only the
 * multiplier differs — so entry/stop/target pass through untouched. */

/** Mini root -> micro root. Every listed micro is exactly 1/10 of its mini. */
const MICRO: Record<string, string> = { ES: "MES", NQ: "MNQ", YM: "MYM", GC: "MGC", CL: "MCL" };

/** The micro contract for a root, or the root itself when it has no micro variant. */
export function microSymbol(root: string): string {
  return MICRO[root] ?? root;
}

export interface SizedOrder {
  /** The (micro) symbol actually traded. */
  symbol: string;
  /** Micro contracts to place. */
  quantity: number;
  /** Dollar risk of a single contract at this stop distance. */
  riskPerContract: number;
  /** The conviction level's configured target. */
  targetRisk: number;
  /** quantity x riskPerContract — the risk we actually take (may differ from target). */
  actualRisk: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Size a signal to a target dollar risk. Returns null when it cannot be sized —
 * no stop, a zero-width stop, a non-positive target, or an unknown point value.
 * The caller SKIPS in that case rather than guessing a size: a position whose risk
 * is unknown is worse than a missed signal.
 */
export function sizeByRisk(signal: Signal, targetRisk: number): SizedOrder | null {
  if (!(targetRisk > 0)) return null;
  if (signal.stopLoss == null) return null;

  const stopPoints = Math.abs(signal.entry - signal.stopLoss);
  if (!(stopPoints > 0)) return null;

  // Only size instruments we have a known micro for. getMultiplier falls back to 1
  // for anything unknown, and sizing at $1/point would be catastrophically wrong
  // (tens of contracts where one was meant), so an unknown instrument SKIPS.
  const symbol = MICRO[signal.market || signal.symbol];
  if (!symbol) return null;

  const pointValue = getMultiplier(symbol);
  if (!(pointValue > 0)) return null;

  const riskPerContract = stopPoints * pointValue;
  // Nearest, floored at 1: a target smaller than one micro still places one micro
  // (slightly over budget) rather than rounding to zero and skipping a live signal.
  const quantity = Math.max(1, Math.round(targetRisk / riskPerContract));

  return {
    symbol,
    quantity,
    riskPerContract: round2(riskPerContract),
    targetRisk,
    actualRisk: round2(quantity * riskPerContract),
  };
}

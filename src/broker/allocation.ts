/* Trade allocation — which SHARE of the eligible signal stream a subscriber copies.
 *
 * Per-user filtering (markets, direction, daily limit) decides what a subscriber is
 * ENTITLED to. Allocation decides how much of that they actually get COPIED, so a
 * fleet of accounts doesn't all place the identical trades. It serves three ends at
 * once:
 *   - anti-detection: two accounts get DIFFERENT subsets (the hash includes userId),
 *     so their trade histories don't look like copy-trading;
 *   - capacity: fewer accounts pile into any one entry;
 *   - tiers: the share IS the product lever — premium 100%, cheaper tiers less.
 *
 * The decision is DETERMINISTIC in (signalId, userId): the same pair always yields
 * the same answer. That is essential — the copy engine re-evaluates every signal on
 * every tick, and a flip-flopping decision would double-place or strand a trade. It
 * is also spread across signals and distinct per user, so each account's subset is
 * a stable, pseudo-random slice of its own.
 *
 * NOTE: shares make accounts DIFFERENT, not perfectly disjoint — two accounts can
 * still both be allocated the same signal. For guaranteed non-overlap you'd assign
 * accounts to cohorts; this is the "share of the stream" model. */

/** FNV-1a over a string → 32-bit unsigned. Cheap, well-spread, no crypto needed. */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Does this subscriber copy this signal, given their allocation percent (0-100)?
 *
 *   100 (or more) → everything (the default; preserves "everyone gets all trades")
 *   0   (or less) → nothing
 *   p            → a stable ~p% slice, distinct per user
 */
export function isAllocated(signalId: string, userId: string, percent: number): boolean {
  if (!(percent < 100)) return true;  // >=100, NaN → full allocation
  if (percent <= 0) return false;
  // 0..99 bucket; include when it falls under the percent threshold.
  return hash32(`${signalId}:${userId}`) % 100 < percent;
}

/* Point-value reconciliation: does dxFeed agree with our sizing multipliers?
 *
 * Risk sizing (sizing.ts) turns a dollar target into a contract count using our
 * point value ($/point). dxFeed enforces its own tickSize/tickValue. If the two
 * disagree, every copied trade's risk is wrong — silently. So verify, per
 * instrument, that dxFeed's (tickValue / tickSize) == our getMultiplier().
 *
 * Read-only. Run: npx tsx src/dxfeed/reconcile.smoke.ts
 */

import { getMultiplier } from "../signals/marks.js";
import { resolveSymbol } from "./symbols.js";
import { dxfeedReady } from "../config.js";

const ROOTS = ["ES", "MES", "NQ", "MNQ", "YM", "MYM", "GC", "MGC", "CL", "MCL"];

let passed = 0, failed = 0;

async function main(): Promise<void> {
  console.log("\ndxFeed point-value reconciliation\n");
  if (!dxfeedReady) { console.error("DXFEED_API_KEY not set."); process.exit(1); }

  console.log("  sym   dxTick   dxTickVal  dxPointVal  ours    match");
  console.log("  ----  -------  ---------  ----------  ------  -----");
  for (const root of ROOTS) {
    const s = await resolveSymbol(root);
    const ours = getMultiplier(root);
    if (!s) { failed++; console.log(`  ${root.padEnd(4)}  (not found on dxFeed)`); continue; }
    const dxPV = s.tickValue / s.tickSize;
    // Relative tolerance — these are exact in practice, but avoid float noise.
    const match = Math.abs(dxPV - ours) <= 1e-6 * Math.max(1, ours);
    if (match) passed++; else failed++;
    console.log(
      `  ${root.padEnd(4)}  ${String(s.tickSize).padEnd(7)}  ${String(s.tickValue).padEnd(9)}  ` +
      `${String(dxPV).padEnd(10)}  ${String(ours).padEnd(6)}  ${match ? "OK" : "*** MISMATCH ***"}`,
    );
  }

  console.log(`\n${passed} matched, ${failed} mismatched\n`);
  if (failed) console.log("A mismatch means our risk sizing would be wrong for that symbol — reconcile before trading.\n");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error("reconcile failed:", err); process.exit(1); });

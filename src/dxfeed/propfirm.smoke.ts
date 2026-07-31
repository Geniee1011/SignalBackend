/* Live READ-ONLY smoke test for the dxFeed Propfirm client.
 *
 * Hits the configured staging API with the x-api-key from env and exercises only
 * non-mutating endpoints — safe to run any time. Proves auth works and the client
 * parses the real payloads. Provisioning (which CREATES entities) is a separate,
 * deliberately-gated script.
 *
 * Run: DXFEED_API_KEY=... npx tsx src/dxfeed/propfirm.smoke.ts
 */

import { config, dxfeedReady } from "../config.js";
import { propfirm } from "./propfirm.js";
import type { DxSymbol } from "./types.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function main(): Promise<void> {
  console.log(`\ndxFeed propfirm smoke → ${config.dxfeed.propfirmUrl}\n`);
  if (!dxfeedReady) {
    console.error("DXFEED_API_KEY is not set — nothing to test. Set it in .env.");
    process.exit(1);
  }

  const enabled = await propfirm.getEnabledAccountsId();
  check("GetEnabledAccountsId returns an array", Array.isArray(enabled), typeof enabled);
  console.log(`        ${enabled.length} enabled account(s)`);

  const symbols = await propfirm.getSymbolList();
  check("GetSymbolList returns instruments", Array.isArray(symbols) && symbols.length > 0, `${symbols?.length}`);
  const by = (n: string): DxSymbol | undefined => symbols.find((s) => s.name === n);
  check("ES present with a tick value", !!by("ES") && by("ES")!.tickValue > 0, JSON.stringify(by("ES")));
  check("MNQ present and tagged micro", by("MNQ")?.symbolGroup === "FUTURE_MICRO", by("MNQ")?.symbolGroup);

  // Show the mini→micro map we'll size against (parallels our sizing.ts MICRO map).
  const roots = ["ES", "MES", "NQ", "MNQ", "YM", "MYM", "GC", "MGC", "CL", "MCL", "RTY"];
  console.log("\n  symbol → dxFeed id / tickValue / exchange:");
  for (const r of roots) {
    const s = by(r);
    if (s) console.log(`    ${r.padEnd(4)} id=${String(s.id).padEnd(4)} tickVal=${String(s.tickValue).padEnd(6)} ${s.exchange} (${s.symbolGroup})`);
    else console.log(`    ${r.padEnd(4)} — not in dxFeed symbol list`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});

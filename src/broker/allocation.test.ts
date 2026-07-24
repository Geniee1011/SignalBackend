/* Allocation tests — pure, no DB. Run: npx tsx src/broker/allocation.test.ts */

import { isAllocated } from "./allocation.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ids = (n: number) => Array.from({ length: n }, (_, i) => `lot:sig-${i}`);
const rate = (userId: string, pct: number, n = 5000) =>
  ids(n).filter((id) => isAllocated(id, userId, pct)).length / n;

console.log("\ntrade allocation\n");

// --- boundary cases --------------------------------------------------------
check("100% → everything", ids(1000).every((id) => isAllocated(id, "u1", 100)));
check(">100% (junk) → everything", ids(1000).every((id) => isAllocated(id, "u1", 150)));
check("0% → nothing", ids(1000).every((id) => !isAllocated(id, "u1", 0)));
check("negative → nothing", ids(1000).every((id) => !isAllocated(id, "u1", -10)));
check("NaN → everything (safe default)", ids(200).every((id) => isAllocated(id, "u1", Number.NaN)));

// --- deterministic ---------------------------------------------------------
{
  const a = ids(500).map((id) => isAllocated(id, "u1", 37));
  const b = ids(500).map((id) => isAllocated(id, "u1", 37));
  check("same (signal,user,pct) → same answer every time", a.every((v, i) => v === b[i]));
}

// --- distribution roughly matches the percent ------------------------------
for (const pct of [10, 25, 50, 75]) {
  const r = rate("u1", pct) * 100;
  check(`~${pct}% of signals allocated (got ${r.toFixed(1)}%)`, Math.abs(r - pct) < 3, `${r.toFixed(1)}%`);
}

// --- distinct per user (the anti-detection property) -----------------------
{
  // At 50%, two different users should get largely DIFFERENT subsets.
  const setA = new Set(ids(2000).filter((id) => isAllocated(id, "userA", 50)));
  const setB = ids(2000).filter((id) => isAllocated(id, "userB", 50));
  const overlap = setB.filter((id) => setA.has(id)).length;
  const bTotal = setB.length;
  // Independent 50%/50% → ~50% of B's picks also in A. Well under "identical".
  const overlapPct = (overlap / bTotal) * 100;
  check(`two users at 50% get different subsets (overlap ${overlapPct.toFixed(0)}%, not ~100%)`,
    overlapPct > 30 && overlapPct < 70, `${overlapPct.toFixed(0)}%`);
  check("the two subsets are not identical", setB.some((id) => !setA.has(id)) && [...setA].some((id) => !setB.includes(id)));
}

// --- a subscriber's own subset is stable across "ticks" --------------------
{
  const tick1 = ids(300).filter((id) => isAllocated(id, "u1", 20));
  const tick2 = ids(300).filter((id) => isAllocated(id, "u1", 20));
  check("subset is identical across repeated evaluations", JSON.stringify(tick1) === JSON.stringify(tick2));
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

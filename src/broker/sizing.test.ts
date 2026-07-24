/* Risk-sizing tests — pure math, no DB. Run: npx tsx src/broker/sizing.test.ts
 *
 * getMultiplier falls back to the built-in table (MES 5, MNQ 2, MYM 0.5, MGC 10,
 * MCL 100) when no upstream mark has been seen, so these are deterministic. */

import { sizeByRisk, microSymbol } from "./sizing.js";
import type { Signal } from "../signals/source.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const sig = (over: Partial<Signal> = {}): Signal => ({
  id: "lot:x", symbol: "ES", market: "ES", side: "SHORT",
  entry: 7478, stopLoss: 7486, takeProfit: 7466, exit: null,
  quantity: 1, conviction: 1, status: "active",
  openedAt: Date.now(), closedAt: null, pnl: null, unrealizedPnl: 0, win: null,
  ...over,
});

console.log("\nrisk sizing\n");

// --- micro mapping ---------------------------------------------------------
check("ES -> MES", microSymbol("ES") === "MES");
check("NQ -> MNQ", microSymbol("NQ") === "MNQ");
check("unknown root maps to itself", microSymbol("ZZ") === "ZZ");

// --- Marvin's worked example ----------------------------------------------
// 1 mini ES, 8-point stop = $400 risk. Level-1 target $100.
// Micro MES = $5/pt -> $40/contract -> round(100/40)=round(2.5)=3 -> $120.
{
  const r = sizeByRisk(sig({ entry: 7478, stopLoss: 7486 }), 100);
  check("sizes to the micro symbol", r?.symbol === "MES", r?.symbol);
  check("8pt stop, $100 target -> 3 MES", r?.quantity === 3, `qty ${r?.quantity}`);
  check("risk/contract = $40", r?.riskPerContract === 40, `${r?.riskPerContract}`);
  check("actual risk = $120 (nearest, slightly over)", r?.actualRisk === 120, `${r?.actualRisk}`);
}

// --- exact division lands on target ---------------------------------------
{
  // 4pt stop -> $20/MES. $100 -> exactly 5 contracts -> $100.
  const r = sizeByRisk(sig({ entry: 7478, stopLoss: 7482 }), 100);
  check("4pt stop, $100 -> 5 MES exactly on target", r?.quantity === 5 && r?.actualRisk === 100,
    `qty ${r?.quantity} risk ${r?.actualRisk}`);
}

// --- other instruments -----------------------------------------------------
{
  const nq = sizeByRisk(sig({ symbol: "NQ", market: "NQ", entry: 20000, stopLoss: 20010 }), 200);
  check("NQ: 10pt stop @ $2/MNQ, $200 -> 10 MNQ", nq?.symbol === "MNQ" && nq?.quantity === 10, `${nq?.symbol} ${nq?.quantity}`);

  const gc = sizeByRisk(sig({ symbol: "GC", market: "GC", entry: 3300, stopLoss: 3305 }), 300);
  check("GC: 5pt stop @ $10/MGC, $300 -> 6 MGC", gc?.symbol === "MGC" && gc?.quantity === 6, `${gc?.symbol} ${gc?.quantity}`);

  const cl = sizeByRisk(sig({ symbol: "CL", market: "CL", entry: 75, stopLoss: 75.5 }), 100);
  check("CL: 0.5pt stop @ $100/MCL, $100 -> 2 MCL", cl?.symbol === "MCL" && cl?.quantity === 2, `${cl?.symbol} ${cl?.quantity}`);
}

// --- conviction scales the size -------------------------------------------
{
  const base = sig({ entry: 7478, stopLoss: 7482 }); // $20/MES
  const l1 = sizeByRisk(base, 100)?.quantity;
  const l4 = sizeByRisk(base, 400)?.quantity;
  check("4x the risk target -> 4x the contracts", l1 === 5 && l4 === 20, `l1 ${l1} l4 ${l4}`);
}

// --- floor of 1 ------------------------------------------------------------
{
  // 8pt stop -> $40/MES. $10 target -> 0.25 -> would round to 0, floored to 1.
  const r = sizeByRisk(sig({ entry: 7478, stopLoss: 7486 }), 10);
  check("tiny target still places 1 (never 0)", r?.quantity === 1, `qty ${r?.quantity}`);
}

// --- unsizeable -> null (caller skips) ------------------------------------
check("no stop -> null", sizeByRisk(sig({ stopLoss: null }), 100) === null);
check("zero-width stop -> null", sizeByRisk(sig({ entry: 7478, stopLoss: 7478 }), 100) === null);
check("non-positive target -> null", sizeByRisk(sig(), 0) === null);
check("unknown instrument -> null (no guess)", sizeByRisk(sig({ symbol: "ZZ", market: "ZZ" }), 100) === null);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

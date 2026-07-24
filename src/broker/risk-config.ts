import { getPool } from "../db/pool.js";

/* The global conviction -> target-risk map.
 *
 * A signal's conviction (the trader's risk phase, 1-4) selects a dollar risk; the
 * copy engine then sizes the trade to it (see sizing.ts). Admin-configured and
 * live-editable from the signals dashboard, so it lives in the DB rather than in
 * env vars. One map for the whole service. */

export type Conviction = 1 | 2 | 3 | 4;
export type RiskConfig = Record<Conviction, number>; // conviction -> USD risk

/** Marvin's defaults: risk climbs $100 per conviction level. */
export const DEFAULT_RISK: RiskConfig = { 1: 100, 2: 200, 3: 300, 4: 400 };

const KEY = "convictionRisk";
const LEVELS: Conviction[] = [1, 2, 3, 4];

/** Coerce arbitrary input to a valid map: each level a positive integer, else the default. */
export function sanitizeRiskConfig(input: unknown): RiskConfig {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_RISK };
  for (const lvl of LEVELS) {
    const v = Number(src[lvl] ?? src[String(lvl)]);
    if (Number.isFinite(v) && v > 0) out[lvl] = Math.round(v);
  }
  return out;
}

/** The configured map, or the defaults when unset or the table is missing. */
export async function getRiskConfig(): Promise<RiskConfig> {
  try {
    const { rows } = await getPool().query(
      `SELECT "value" FROM "signal"."AppSetting" WHERE "key" = $1`,
      [KEY],
    );
    return rows[0] ? sanitizeRiskConfig(rows[0].value) : { ...DEFAULT_RISK };
  } catch {
    // Table not migrated yet → fall back to defaults rather than break sizing.
    return { ...DEFAULT_RISK };
  }
}

/** Persist the map (sanitized). Returns what was stored. */
export async function setRiskConfig(input: unknown): Promise<RiskConfig> {
  const clean = sanitizeRiskConfig(input);
  await getPool().query(
    `INSERT INTO "signal"."AppSetting" ("key","value","updatedAt")
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`,
    [KEY, JSON.stringify(clean)],
  );
  return clean;
}

/** Target risk for a signal's conviction, clamped into 1-4. */
export function riskForConviction(config: RiskConfig, conviction: number): number {
  const lvl = Math.min(4, Math.max(1, Math.round(conviction || 1))) as Conviction;
  return config[lvl];
}

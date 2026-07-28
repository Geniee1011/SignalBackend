import { getPool } from "../db/pool.js";

/* The global DEFAULT base dollar-risk per trade.
 *
 * The risk taken on a copied signal is: base × conviction level (1..4). The copy
 * engine then sizes the trade in micro contracts to hit that dollar figure (see
 * sizing.ts) — so a level-4 signal carries 4× the size of a level-1, off one
 * number. Each subscriber can override the base on their own account
 * (copyBaseRisk); THIS is the fallback for anyone who hasn't. Admin-configured and
 * live-editable from the dashboard, so it lives in the DB rather than in env vars. */

/** Marvin's default: $100 of risk per conviction level (1→$100 … 4→$400). */
export const DEFAULT_BASE_RISK = 100;

const KEY = "baseRisk";
const MIN = 1;
const MAX = 100_000;

/**
 * Coerce arbitrary input to a positive whole-dollar base, else the default.
 * Accepts a bare number (100) or an object ({ baseRisk: 100 }) so it works on
 * both the stored jsonb value and an admin request body.
 */
export function sanitizeBaseRisk(input: unknown): number {
  const raw =
    input && typeof input === "object" ? (input as Record<string, unknown>).baseRisk : input;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < MIN) return DEFAULT_BASE_RISK;
  return Math.min(n, MAX);
}

/** The configured global base, or the default when unset or the table is missing. */
export async function getBaseRisk(): Promise<number> {
  try {
    const { rows } = await getPool().query(
      `SELECT "value" FROM "signal"."AppSetting" WHERE "key" = $1`,
      [KEY],
    );
    return rows[0] ? sanitizeBaseRisk(rows[0].value) : DEFAULT_BASE_RISK;
  } catch {
    // Table not migrated yet → fall back to the default rather than break sizing.
    return DEFAULT_BASE_RISK;
  }
}

/** Persist the global base (sanitized). Returns what was stored. */
export async function setBaseRisk(input: unknown): Promise<number> {
  const clean = sanitizeBaseRisk(input);
  await getPool().query(
    `INSERT INTO "signal"."AppSetting" ("key","value","updatedAt")
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`,
    [KEY, JSON.stringify(clean)],
  );
  return clean;
}

/** Target dollar risk for a signal: base × conviction level, clamped to 1..4. */
export function riskForConviction(base: number, conviction: number): number {
  const lvl = Math.min(4, Math.max(1, Math.round(conviction || 1)));
  return base * lvl;
}

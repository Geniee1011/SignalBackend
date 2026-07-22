import { getPool } from "../db/pool.js";
import { MARKETS } from "../access/access.js";

/* Per-user auto-copy settings.
 *
 * Deliberately SEPARATE from AccessConfig. Access answers "which signals may this
 * subscriber SEE"; this answers "which of those should be TRADED, and how big".
 * A user may well watch every market but auto-trade only NQ, and folding the two
 * together would make that impossible to express.
 *
 * Access is applied FIRST and always wins — the engine can never trade a signal
 * the subscriber isn't entitled to see. */

export type CopyMode = "off" | "confirm" | "auto";

export interface CopySettings {
  /**
   * off     — nothing happens.
   * confirm — an order is PREPARED and queued for the user to approve. Required
   *           where a venue permits automation only with active human oversight.
   * auto    — placed without confirmation.
   */
  mode: CopyMode;
  markets: string[]; // [] = every market they can see
  minConviction: number; // 1..4
  quantity: number; // contracts per signal
  maxConcurrent: number; // open copied positions at once
  maxPerDay: number; // copied orders per rolling day
}

export const DEFAULT_COPY: CopySettings = {
  // Off, and 1 contract: the defaults must be the safest possible position for a
  // user who never opens the settings page.
  mode: "off",
  markets: [],
  minConviction: 1,
  quantity: 1,
  maxConcurrent: 3,
  maxPerDay: 10,
};

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

/** Map the signal."User" copy* columns into a typed config. */
export function mapCopySettings(r: Record<string, unknown>): CopySettings {
  const raw = r.copyMode;
  // `copyEnabled` predates the three-way mode; a legacy true means "auto".
  const mode: CopyMode =
    raw === "auto" || raw === "confirm" || raw === "off" ? raw : r.copyEnabled === true ? "auto" : "off";
  return {
    mode,
    markets: Array.isArray(r.copyMarkets) ? (r.copyMarkets as string[]) : [],
    minConviction: clampInt(r.copyMinConviction, 1, 4, 1),
    quantity: clampInt(r.copyQuantity, 1, 100, 1),
    maxConcurrent: clampInt(r.copyMaxConcurrent, 1, 50, 3),
    maxPerDay: clampInt(r.copyMaxPerDay, 1, 200, 10),
  };
}

/** Coerce untrusted input from the settings UI. Never throws. */
export function sanitizeCopySettings(input: unknown): CopySettings {
  const o = (input ?? {}) as Record<string, unknown>;
  const mode: CopyMode = o.mode === "auto" || o.mode === "confirm" ? o.mode : "off";
  const markets = Array.isArray(o.markets)
    ? [...new Set(o.markets.map((m) => String(m).toUpperCase()))].filter((m) => (MARKETS as readonly string[]).includes(m))
    : [];
  return {
    mode,
    markets,
    minConviction: clampInt(o.minConviction, 1, 4, 1),
    quantity: clampInt(o.quantity, 1, 100, 1),
    maxConcurrent: clampInt(o.maxConcurrent, 1, 50, 3),
    maxPerDay: clampInt(o.maxPerDay, 1, 200, 10),
  };
}

export async function getCopySettings(userId: string): Promise<CopySettings> {
  const { rows } = await getPool().query(
    `SELECT "copyMode","copyEnabled","copyMarkets","copyMinConviction","copyQuantity",
            "copyMaxConcurrent","copyMaxPerDay"
     FROM "signal"."User" WHERE "id" = $1`,
    [userId],
  );
  return rows[0] ? mapCopySettings(rows[0]) : DEFAULT_COPY;
}

export async function updateCopySettings(userId: string, s: CopySettings): Promise<void> {
  await getPool().query(
    `UPDATE "signal"."User"
     SET "copyMode" = $2, "copyEnabled" = $3, "copyMarkets" = $4, "copyMinConviction" = $5,
         "copyQuantity" = $6, "copyMaxConcurrent" = $7, "copyMaxPerDay" = $8, "updatedAt" = now()
     WHERE "id" = $1`,
    [userId, s.mode, s.mode === "auto", s.markets, s.minConviction, s.quantity, s.maxConcurrent, s.maxPerDay],
  );
}

/** Every user with copying switched on — the engine's work list. */
export async function listCopyUsers(): Promise<{ userId: string; settings: CopySettings }[]> {
  const { rows } = await getPool().query(
    `SELECT "id","copyMode","copyEnabled","copyMarkets","copyMinConviction","copyQuantity",
            "copyMaxConcurrent","copyMaxPerDay"
     FROM "signal"."User"
     WHERE "status" = 'ACTIVE' AND "accessSuspended" = false
       AND ("copyMode" IN ('auto','confirm') OR "copyEnabled" = true)`,
  );
  return rows.map((r) => ({ userId: r.id as string, settings: mapCopySettings(r) }));
}

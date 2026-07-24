import { getPool } from "../db/pool.js";
import type { Signal } from "../signals/source.js";

/* ---------------------------------------------------------------------------
 * Per-user ACCESS (entitlements) — the core of the signal-app admin.
 *
 * Each subscriber has an access config that gates which signals they receive on
 * their live feed. The admin dashboard edits it; the /api/signals and
 * /api/performance endpoints enforce it. Everything here lives under the
 * "signal" schema — the trading tables are never touched.
 * ------------------------------------------------------------------------- */

export const MARKETS = ["ES", "NQ", "YM", "GC", "CL"] as const;
export type Direction = "LONG" | "SHORT" | "BOTH";

export interface AccessConfig {
  markets: string[]; // allowed markets; [] = all
  direction: Direction; // which side(s) they receive
  dailyLimit: number | null; // max signals/day; null = unlimited (extras are locked)
  minConviction: number; // only deliver conviction >= this (1..4)
  live: boolean; // see ACTIVE (live) signals, or only closed history
  suspended: boolean; // cut the feed entirely
  // COPY share of eligible signals (0-100). The subscriber still SEES all of them;
  // only the copy engine trades this slice, so many accounts don't place identical
  // trades. 100 = copy everything (the default, i.e. unchanged behaviour).
  allocationPercent: number;
}

export const DEFAULT_ACCESS: AccessConfig = {
  markets: [],
  direction: "BOTH",
  dailyLimit: null,
  minConviction: 1,
  live: true,
  suspended: false,
  allocationPercent: 100,
};

/** Map a raw signal."User" row's access columns into a typed config. */
export function mapAccess(r: Record<string, unknown>): AccessConfig {
  const dir = r.accessDirection;
  return {
    markets: Array.isArray(r.accessMarkets) ? (r.accessMarkets as string[]) : [],
    direction: dir === "LONG" || dir === "SHORT" ? dir : "BOTH",
    dailyLimit: r.accessDailyLimit == null ? null : Number(r.accessDailyLimit),
    minConviction: r.accessMinConviction == null ? 1 : Number(r.accessMinConviction),
    live: r.accessLive !== false,
    suspended: r.accessSuspended === true,
    allocationPercent: r.accessAllocationPercent == null ? 100 : clampPercent(Number(r.accessAllocationPercent)),
  };
}

/** Clamp an allocation percent to a whole number in [0, 100]; default 100. */
function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * Coerce an untrusted partial (from the admin editor) into a valid AccessConfig,
 * dropping anything malformed. Never throws.
 */
export function sanitizeAccess(input: unknown): AccessConfig {
  const o = (input ?? {}) as Record<string, unknown>;
  const markets = Array.isArray(o.markets)
    ? [...new Set(o.markets.map((m) => String(m).toUpperCase()))].filter((m) => (MARKETS as readonly string[]).includes(m))
    : [];
  const direction: Direction = o.direction === "LONG" || o.direction === "SHORT" ? o.direction : "BOTH";
  let dailyLimit: number | null = null;
  if (o.dailyLimit != null && o.dailyLimit !== "") {
    const n = Math.floor(Number(o.dailyLimit));
    if (Number.isFinite(n) && n >= 0) dailyLimit = n;
  }
  let minConviction = Math.floor(Number(o.minConviction));
  if (!Number.isFinite(minConviction) || minConviction < 1) minConviction = 1;
  if (minConviction > 4) minConviction = 4;
  return {
    markets,
    direction,
    dailyLimit,
    minConviction,
    live: o.live !== false,
    suspended: o.suspended === true,
    allocationPercent: o.allocationPercent == null ? 100 : clampPercent(Number(o.allocationPercent)),
  };
}

/** Timestamp used for day-bucketing / ordering a signal. */
const tsOf = (s: Signal): number => (s.status === "active" ? s.openedAt : (s.closedAt ?? s.openedAt));
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10); // UTC calendar day

/** Hide a locked signal's tradeable detail while keeping the row as a teaser. */
function lockSignal(s: Signal): Signal {
  return { ...s, entry: 0, stopLoss: null, takeProfit: null, exit: null, pnl: null, unrealizedPnl: null, locked: true };
}

/**
 * Enforce a user's access on a signal set:
 *  - suspended            → empty feed
 *  - markets / direction  → filtered out
 *  - minConviction        → filtered out below the floor
 *  - live=false           → drop ACTIVE signals (closed history only)
 *  - dailyLimit           → keep the newest N per calendar day; LOCK the rest
 */
export function applyAccess(signals: Signal[], access: AccessConfig): Signal[] {
  if (access.suspended) return [];

  let out = signals.filter((s) => {
    if (access.markets.length && !access.markets.includes(s.market)) return false;
    if (access.direction !== "BOTH" && s.side !== access.direction) return false;
    if ((s.conviction || 1) < access.minConviction) return false;
    if (!access.live && s.status === "active") return false;
    return true;
  });

  if (access.dailyLimit != null && access.dailyLimit >= 0) {
    const byDay = new Map<string, Signal[]>();
    for (const s of out) {
      const k = dayKey(tsOf(s));
      const arr = byDay.get(k);
      if (arr) arr.push(s);
      else byDay.set(k, [s]);
    }
    const lockedIds = new Set<string>();
    for (const arr of byDay.values()) {
      arr.sort((a, b) => tsOf(b) - tsOf(a)); // newest first
      for (const s of arr.slice(access.dailyLimit)) lockedIds.add(s.id);
    }
    if (lockedIds.size) out = out.map((s) => (lockedIds.has(s.id) ? lockSignal(s) : s));
  }

  return out;
}

// --- persistence -----------------------------------------------------------

const ACCESS_COLS =
  `"accessMarkets","accessDirection","accessDailyLimit","accessMinConviction","accessLive","accessSuspended","accessAllocationPercent"`;

/** Read one user's access config (defaults if the row is missing). */
export async function getUserAccess(userId: string): Promise<AccessConfig> {
  const { rows } = await getPool().query(
    `SELECT ${ACCESS_COLS} FROM "signal"."User" WHERE "id" = $1`,
    [userId],
  );
  return rows[0] ? mapAccess(rows[0]) : { ...DEFAULT_ACCESS };
}

/** Overwrite one user's access config. */
export async function updateUserAccess(userId: string, access: AccessConfig): Promise<void> {
  await getPool().query(
    `UPDATE "signal"."User" SET
       "accessMarkets" = $2, "accessDirection" = $3, "accessDailyLimit" = $4,
       "accessMinConviction" = $5, "accessLive" = $6, "accessSuspended" = $7,
       "accessAllocationPercent" = $8,
       "updatedAt" = now()
     WHERE "id" = $1`,
    [userId, access.markets, access.direction, access.dailyLimit, access.minConviction, access.live, access.suspended, access.allocationPercent],
  );
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  role: "SUBSCRIBER" | "ADMIN";
  status: "ACTIVE" | "SUSPENDED";
  createdAt: number;
  access: AccessConfig;
}

/** List every signal-app user with their access config, for the admin overview. */
export async function listUsersWithAccess(): Promise<AdminUserRow[]> {
  const { rows } = await getPool().query(
    `SELECT "id","email","name","role","status","createdAt",${ACCESS_COLS}
     FROM "signal"."User" ORDER BY "createdAt" ASC`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    email: String(r.email),
    name: (r.name as string | null) ?? null,
    role: r.role === "ADMIN" ? "ADMIN" : "SUBSCRIBER",
    status: r.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
    createdAt: new Date(r.createdAt as string).getTime(),
    access: mapAccess(r),
  }));
}

/** Set a user's login status (ACTIVE blocks nothing; SUSPENDED blocks login). */
export async function setUserStatus(userId: string, status: "ACTIVE" | "SUSPENDED"): Promise<void> {
  await getPool().query(
    `UPDATE "signal"."User" SET "status" = $2, "updatedAt" = now() WHERE "id" = $1`,
    [userId, status],
  );
}

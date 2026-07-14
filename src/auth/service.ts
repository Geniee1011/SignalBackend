import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { getPool } from "../db/pool.js";

/* Auth for signal-app customers (signal."User"). Fully independent of the
   trading platform's auth — own table, own JWT secret. scrypt hashing keeps the
   dependency footprint native-free. */

export interface SignalUser {
  id: string;
  email: string;
  name: string | null;
  role: "SUBSCRIBER" | "ADMIN";
  status: "ACTIVE" | "SUSPENDED";
}

export interface TokenPayload {
  sub: string;
  email: string;
  role: string;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function signToken(user: SignalUser): string {
  const payload: TokenPayload = { sub: user.id, email: user.email, role: user.role };
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresInSec });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, config.jwt.secret) as TokenPayload;
  } catch {
    return null;
  }
}

const mapUser = (r: Record<string, unknown>): SignalUser => ({
  id: String(r.id),
  email: String(r.email),
  name: (r.name as string | null) ?? null,
  role: r.role === "ADMIN" ? "ADMIN" : "SUBSCRIBER",
  status: r.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
});

export interface AuthResult {
  token: string;
  user: SignalUser;
}

export async function register(email: string, password: string, name?: string): Promise<AuthResult | { error: string }> {
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { error: "Invalid email." };
  if (password.length < 6) return { error: "Password must be at least 6 characters." };
  const exists = await getPool().query(`SELECT 1 FROM "signal"."User" WHERE "email" = $1`, [e]);
  if (exists.rowCount) return { error: "An account with this email already exists." };
  const { rows } = await getPool().query(
    `INSERT INTO "signal"."User" ("email","passwordHash","name") VALUES ($1,$2,$3)
     RETURNING "id","email","name","role","status"`,
    [e, hashPassword(password), name?.trim() || null],
  );
  const user = mapUser(rows[0]!);
  return { token: signToken(user), user };
}

export async function login(email: string, password: string): Promise<AuthResult | { error: string }> {
  const e = email.trim().toLowerCase();
  const { rows } = await getPool().query(
    `SELECT "id","email","name","role","status","passwordHash" FROM "signal"."User" WHERE "email" = $1`,
    [e],
  );
  const row = rows[0];
  if (!row || !verifyPassword(password, String(row.passwordHash))) return { error: "Invalid email or password." };
  if (row.status === "SUSPENDED") return { error: "This account is suspended." };
  const user = mapUser(row);
  return { token: signToken(user), user };
}

export async function getUserById(id: string): Promise<SignalUser | null> {
  const { rows } = await getPool().query(
    `SELECT "id","email","name","role","status" FROM "signal"."User" WHERE "id" = $1`,
    [id],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

/**
 * Ensure an ADMIN account exists (from SIGNAL_ADMIN_EMAIL / SIGNAL_ADMIN_PASSWORD).
 * Creates it if missing, or promotes an existing user to ADMIN. Idempotent; safe to
 * call on every boot. Never changes an existing user's password.
 */
export async function ensureAdmin(email: string, password: string, name = "Admin"): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!e || !password) return;
  const { rows } = await getPool().query(`SELECT "id","role" FROM "signal"."User" WHERE "email" = $1`, [e]);
  if (rows[0]) {
    if (rows[0].role !== "ADMIN") {
      await getPool().query(`UPDATE "signal"."User" SET "role" = 'ADMIN', "updatedAt" = now() WHERE "email" = $1`, [e]);
      console.log(`[admin] promoted ${e} to ADMIN`);
    }
    return;
  }
  await getPool().query(
    `INSERT INTO "signal"."User" ("email","passwordHash","name","role") VALUES ($1,$2,$3,'ADMIN')`,
    [e, hashPassword(password), name],
  );
  console.log(`[admin] bootstrapped signal admin ${e}`);
}

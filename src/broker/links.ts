import { getPool } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { forgetCredentials, resolveAccount, type TradovateCredentials, type TradovateEnv } from "./tradovate.js";

/* Broker link storage.
 *
 * ONE-TO-ONE: the UNIQUE("userId") constraint means a subscriber has at most one
 * linked account, so connecting again REPLACES the existing link rather than
 * creating a second one. Widening to one-user-many-accounts is a constraint drop
 * plus a chosen-account id on the copy config; nothing here assumes singularity
 * beyond the upsert.
 *
 * Secrets are encrypted going in and only decrypted inside `credentialsFor`,
 * which is the single seam where plaintext exists. Nothing else in the codebase
 * can reach them, and no route returns them. */

export interface BrokerLinkPublic {
  connected: boolean;
  broker: string;
  env: TradovateEnv;
  username: string | null; // shown so the user can confirm WHICH account is linked
  accountId: number | null;
  accountName: string | null;
  status: "PENDING" | "CONNECTED" | "ERROR";
  lastError: string | null;
  lastCheckedAt: number | null;
}

export const NOT_CONNECTED: BrokerLinkPublic = {
  connected: false,
  broker: "tradovate",
  env: "demo",
  username: null,
  accountId: null,
  accountName: null,
  status: "PENDING",
  lastError: null,
  lastCheckedAt: null,
};

interface LinkRow {
  userId: string;
  broker: string;
  env: string;
  usernameEnc: string;
  passwordEnc: string;
  cidEnc: string;
  secEnc: string;
  accountId: number | null;
  accountName: string | null;
  status: string;
  lastError: string | null;
  lastCheckedAt: Date | null;
}

async function rowFor(userId: string): Promise<LinkRow | null> {
  const { rows } = await getPool().query<LinkRow>(
    `SELECT "userId","broker","env","usernameEnc","passwordEnc","cidEnc","secEnc",
            "accountId","accountName","status","lastError","lastCheckedAt"
     FROM "signal"."BrokerLink" WHERE "userId" = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** The user-facing view of a link — never includes a password or API secret. */
export async function getLink(userId: string): Promise<BrokerLinkPublic> {
  const row = await rowFor(userId);
  if (!row) return NOT_CONNECTED;
  return {
    connected: row.status === "CONNECTED",
    broker: row.broker,
    env: (row.env === "live" ? "live" : "demo") as TradovateEnv,
    username: decryptSecret(row.usernameEnc), // identifying, not a secret
    accountId: row.accountId,
    accountName: row.accountName,
    status: (row.status as BrokerLinkPublic["status"]) ?? "PENDING",
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.getTime() : null,
  };
}

/**
 * Decrypted credentials for server-side use. The ONLY place plaintext exists.
 * Returns null when unlinked or when the blobs can't be decrypted (the encryption
 * key changed) — callers must treat that as "not connected", never as an error to
 * retry, because retrying can't fix a wrong key.
 */
export async function credentialsFor(userId: string): Promise<TradovateCredentials | null> {
  const row = await rowFor(userId);
  if (!row) return null;
  const username = decryptSecret(row.usernameEnc);
  const password = decryptSecret(row.passwordEnc);
  const cid = decryptSecret(row.cidEnc);
  const sec = decryptSecret(row.secEnc);
  if (!username || !password || !cid || !sec) return null;
  return { username, password, cid, sec, env: row.env === "live" ? "live" : "demo" };
}

export interface ConnectInput {
  username: string;
  password: string;
  cid: string;
  sec: string;
  env: TradovateEnv;
}

/**
 * Verify credentials against Tradovate, then persist the link.
 *
 * Verification happens BEFORE the write, so a failed connection never leaves a
 * broken link behind that automation might later try to trade through.
 */
export async function connect(userId: string, input: ConnectInput): Promise<BrokerLinkPublic> {
  const creds: TradovateCredentials = { ...input };
  const account = await resolveAccount(creds); // throws TradovateError on bad credentials

  await getPool().query(
    `INSERT INTO "signal"."BrokerLink"
       ("userId","broker","env","usernameEnc","passwordEnc","cidEnc","secEnc",
        "accountId","accountSpec","accountName","status","lastError","lastCheckedAt","updatedAt")
     VALUES ($1,'tradovate',$2,$3,$4,$5,$6,$7,$8,$9,'CONNECTED',NULL,now(),now())
     ON CONFLICT ("userId") DO UPDATE SET
       "env" = EXCLUDED."env",
       "usernameEnc" = EXCLUDED."usernameEnc",
       "passwordEnc" = EXCLUDED."passwordEnc",
       "cidEnc" = EXCLUDED."cidEnc",
       "secEnc" = EXCLUDED."secEnc",
       "accountId" = EXCLUDED."accountId",
       "accountSpec" = EXCLUDED."accountSpec",
       "accountName" = EXCLUDED."accountName",
       "status" = 'CONNECTED',
       "lastError" = NULL,
       "lastCheckedAt" = now(),
       "updatedAt" = now()`,
    [
      userId,
      input.env,
      encryptSecret(input.username),
      encryptSecret(input.password),
      encryptSecret(input.cid),
      encryptSecret(input.sec),
      account.id,
      account.name,
      account.nickname ?? account.name,
    ],
  );
  return getLink(userId);
}

/** Remove the link and forget any cached token for it. */
export async function disconnect(userId: string): Promise<void> {
  const creds = await credentialsFor(userId);
  if (creds) forgetCredentials(creds);
  await getPool().query(`DELETE FROM "signal"."BrokerLink" WHERE "userId" = $1`, [userId]);
}

/** Record a failure against the link so the UI can explain why copying stopped. */
export async function markError(userId: string, message: string): Promise<void> {
  await getPool().query(
    `UPDATE "signal"."BrokerLink"
     SET "status" = 'ERROR', "lastError" = $2, "lastCheckedAt" = now(), "updatedAt" = now()
     WHERE "userId" = $1`,
    [userId, message.slice(0, 500)],
  );
}

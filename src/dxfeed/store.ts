import { getPool } from "../db/pool.js";

/* Persistence for the subscriber → dxFeed account link (signal.DxFeedAccount).
 *
 * One row per subscriber. The provisioning service (provision.ts) upserts this
 * progressively — after the dxFeed user is created, then the account, then the
 * subscription — so a retry can resume from wherever it stopped rather than
 * creating duplicates. */

export interface DxFeedLink {
  userId: string;
  dxUserId: string;
  dxAccountId: string | null;
  dxSubscriptionId: string | null;
  accountStatus: number | null;
  subscriptionStatus: number | null;
  agreementSigned: boolean;
  agreementLink: string | null;
  platform: number | null;
  /** When a real order was last proven to be ACCEPTED on this account, or null
   *  if never. See the schema comment on DxFeedAccount — provisioning success is
   *  not evidence the account can trade. */
  tradeVerifiedAt: Date | null;
  /** Why the last readiness probe failed, kept for the admin view. */
  tradeProbeError: string | null;
}

/** What provisioning writes. Readiness is deliberately NOT part of it: it is
 *  earned by probing, never asserted by the code path that creates the account,
 *  and a re-provision must not be able to silently mark a subscriber tradeable. */
export type DxFeedLinkInput = Omit<DxFeedLink, "tradeVerifiedAt" | "tradeProbeError">;

const COLS =
  `"userId","dxUserId","dxAccountId","dxSubscriptionId","accountStatus","subscriptionStatus","agreementSigned","agreementLink","platform","tradeVerifiedAt","tradeProbeError"`;

function mapRow(r: Record<string, unknown>): DxFeedLink {
  return {
    userId: String(r.userId),
    dxUserId: String(r.dxUserId),
    dxAccountId: (r.dxAccountId as string | null) ?? null,
    dxSubscriptionId: (r.dxSubscriptionId as string | null) ?? null,
    accountStatus: r.accountStatus == null ? null : Number(r.accountStatus),
    subscriptionStatus: r.subscriptionStatus == null ? null : Number(r.subscriptionStatus),
    agreementSigned: r.agreementSigned === true,
    agreementLink: (r.agreementLink as string | null) ?? null,
    platform: r.platform == null ? null : Number(r.platform),
    tradeVerifiedAt: r.tradeVerifiedAt ? new Date(r.tradeVerifiedAt as string) : null,
    tradeProbeError: (r.tradeProbeError as string | null) ?? null,
  };
}

/** The subscriber's dxFeed link, or null if they've never been provisioned. */
export async function getDxFeedLink(userId: string): Promise<DxFeedLink | null> {
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM "signal"."DxFeedAccount" WHERE "userId" = $1`,
    [userId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Look a subscriber up by the account id dxFeed reports (e.g. from a webhook). */
export async function getLinkByAccountId(dxAccountId: string): Promise<DxFeedLink | null> {
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM "signal"."DxFeedAccount" WHERE "dxAccountId" = $1`,
    [dxAccountId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Look a subscriber up by dxFeed user id (subscription webhooks key on this). */
export async function getLinkByDxUserId(dxUserId: string): Promise<DxFeedLink | null> {
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM "signal"."DxFeedAccount" WHERE "dxUserId" = $1`,
    [dxUserId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Insert or update the whole link row (upsert on userId). Leaves the readiness
 *  columns alone — they are owned by markTradeVerified/clearTradeVerified. */
export async function upsertDxFeedLink(link: DxFeedLinkInput): Promise<void> {
  await getPool().query(
    `INSERT INTO "signal"."DxFeedAccount"
       ("userId","dxUserId","dxAccountId","dxSubscriptionId","accountStatus",
        "subscriptionStatus","agreementSigned","agreementLink","platform","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT ("userId") DO UPDATE SET
       "dxUserId" = EXCLUDED."dxUserId",
       "dxAccountId" = EXCLUDED."dxAccountId",
       "dxSubscriptionId" = EXCLUDED."dxSubscriptionId",
       "accountStatus" = EXCLUDED."accountStatus",
       "subscriptionStatus" = EXCLUDED."subscriptionStatus",
       "agreementSigned" = EXCLUDED."agreementSigned",
       "agreementLink" = EXCLUDED."agreementLink",
       "platform" = EXCLUDED."platform",
       "updatedAt" = now()`,
    [
      link.userId, link.dxUserId, link.dxAccountId, link.dxSubscriptionId,
      link.accountStatus, link.subscriptionStatus, link.agreementSigned,
      link.agreementLink, link.platform,
    ],
  );
}

/** Record that a real order was accepted on this subscriber's account. */
export async function markTradeVerified(userId: string): Promise<void> {
  await getPool().query(
    `UPDATE "signal"."DxFeedAccount"
     SET "tradeVerifiedAt" = now(), "tradeProbeError" = NULL, "updatedAt" = now()
     WHERE "userId" = $1`,
    [userId],
  );
}

/**
 * Withdraw trade readiness. Called both when the probe fails and when a LIVE
 * order times out waiting for an ack — the same silent-drop symptom either way,
 * and continuing to route signals at an account in that state loses them without
 * any rejection to alert on.
 */
export async function clearTradeVerified(userId: string, error: string): Promise<void> {
  await getPool().query(
    `UPDATE "signal"."DxFeedAccount"
     SET "tradeVerifiedAt" = NULL, "tradeProbeError" = $2, "updatedAt" = now()
     WHERE "userId" = $1`,
    [userId, error.slice(0, 500)],
  );
}

/** Subscribers that have a dxFeed account but have never been proven tradeable.
 *  Oldest first, so a backlog drains in the order people signed up. */
export async function listUnverified(limit = 25): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT "userId" FROM "signal"."DxFeedAccount"
     WHERE "dxAccountId" IS NOT NULL AND "tradeVerifiedAt" IS NULL
     ORDER BY "createdAt"
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => String(r.userId));
}

export interface ReadinessRow {
  userId: string;
  email: string;
  name: string | null;
  dxAccountId: string | null;
  accountStatus: number | null;
  tradeVerifiedAt: Date | null;
  tradeProbeError: string | null;
}

/**
 * Every subscriber and whether they can actually be copy-traded.
 *
 * LEFT JOIN, not JOIN: a subscriber with no dxFeed account at all is precisely
 * the case an admin needs to see and act on, and an inner join would hide them.
 * Not-tradeable first (unprovisioned, then unverified) — those are the only rows
 * anyone has to do anything about.
 */
export async function listReadiness(): Promise<ReadinessRow[]> {
  const { rows } = await getPool().query(
    `SELECT u."id" AS "userId", u."email", u."name", a."dxAccountId", a."accountStatus",
            a."tradeVerifiedAt", a."tradeProbeError"
     FROM "signal"."User" u
     LEFT JOIN "signal"."DxFeedAccount" a ON a."userId" = u."id"
     WHERE u."role" = 'SUBSCRIBER'
     ORDER BY (a."tradeVerifiedAt" IS NOT NULL), (a."dxAccountId" IS NOT NULL), u."createdAt"`,
  );
  return rows as ReadinessRow[];
}

/** Remove the link (does not touch dxFeed — used by tests/cleanup). */
export async function deleteDxFeedLink(userId: string): Promise<void> {
  await getPool().query(`DELETE FROM "signal"."DxFeedAccount" WHERE "userId" = $1`, [userId]);
}

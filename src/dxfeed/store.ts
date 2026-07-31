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
}

const COLS =
  `"userId","dxUserId","dxAccountId","dxSubscriptionId","accountStatus","subscriptionStatus","agreementSigned","agreementLink","platform"`;

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

/** Insert or update the whole link row (upsert on userId). */
export async function upsertDxFeedLink(link: DxFeedLink): Promise<void> {
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

/** Remove the link (does not touch dxFeed — used by tests/cleanup). */
export async function deleteDxFeedLink(userId: string): Promise<void> {
  await getPool().query(`DELETE FROM "signal"."DxFeedAccount" WHERE "userId" = $1`, [userId]);
}

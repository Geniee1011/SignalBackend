/* Webhook handler tests — drive the receiver with synthetic dxFeed events and
 * assert the local link is updated + the 200/401 contract holds.
 *
 * Uses a throwaway subscriber + link, cleaned up in finally.
 * Run: npx tsx src/dxfeed/webhook.test.ts
 */

import { getPool } from "../db/pool.js";
import { config } from "../config.js";
import { handleDxFeedWebhook, NotificationCategory, NotificationEvent } from "./webhook.js";
import { upsertDxFeedLink, getDxFeedLink, deleteDxFeedLink } from "./store.js";
import { AccountStatus } from "./types.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function main(): Promise<void> {
  console.log("\ndxFeed webhook handler\n");
  const key = config.dxfeed.apiKey || "test-key";
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO "signal"."User" ("email","passwordHash","name","role","status")
     VALUES ($1,'x','WH Test','SUBSCRIBER','ACTIVE') RETURNING "id"`,
    [`wh-${Date.now()}@example.com`],
  );
  const userId = rows[0].id as string;
  const dxUserId = `dxu-${Date.now()}`;
  const dxAccountId = `dxa-${Date.now()}`;

  try {
    await upsertDxFeedLink({
      userId, dxUserId, dxAccountId, dxSubscriptionId: "sub-1",
      accountStatus: AccountStatus.ENABLED, subscriptionStatus: 3,
      agreementSigned: false, agreementLink: "http://sign.me", platform: 0,
    });

    // 1. Bad key → 401, no processing.
    {
      const r = await handleDxFeedWebhook("wrong-key", { category: 0, event: 1 });
      check("rejects a bad x-api-key with 401", r.status === 401, `${r.status}`);
    }

    // 2. Account challenge-failed → status persisted, still 200.
    {
      const r = await handleDxFeedWebhook(key, {
        category: NotificationCategory.ACCOUNTS, event: NotificationEvent.UPDATED,
        accountId: dxAccountId,
        tradingAccount: { id: dxAccountId, status: AccountStatus.CHALLENGE_FAILED, reason: "TRADING_RULE_MAX_DD" },
      });
      check("account event acked 200", r.status === 200, `${r.status}`);
      const link = await getDxFeedLink(userId);
      check("account status updated to CHALLENGE_FAILED", link?.accountStatus === AccountStatus.CHALLENGE_FAILED, `${link?.accountStatus}`);
    }

    // 3. Subscription signed → agreementSigned flips (keyed by dxUserId).
    {
      const r = await handleDxFeedWebhook(key, {
        category: NotificationCategory.SUBSCRIPTIONS, event: NotificationEvent.UPDATED,
        userId: dxUserId,
        subscription: { subscriptionId: "sub-1", status: 1, dxAgreementSigned: true },
      });
      check("subscription event acked 200", r.status === 200);
      const link = await getDxFeedLink(userId);
      check("agreementSigned flipped true", link?.agreementSigned === true, `${link?.agreementSigned}`);
      check("subscriptionStatus updated to Active(1)", link?.subscriptionStatus === 1, `${link?.subscriptionStatus}`);
    }

    // 4. Unknown account → still 200 (never blocks the queue), no crash.
    {
      const r = await handleDxFeedWebhook(key, {
        category: NotificationCategory.ACCOUNTS, event: 1, accountId: "not-ours",
        tradingAccount: { id: "not-ours", status: 8 },
      });
      check("unknown account still acked 200", r.status === 200);
    }

    // 5. Trade report → accepted (logged), 200.
    {
      const r = await handleDxFeedWebhook(key, {
        category: NotificationCategory.TRADE_REPORT, event: 0, accountId: dxAccountId,
        tradeReport: { pnl: 125, symbolName: "MES" },
      });
      check("trade report acked 200", r.status === 200);
    }
  } finally {
    await deleteDxFeedLink(userId);
    await pool.query(`DELETE FROM "signal"."User" WHERE "id" = $1`, [userId]);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error("test crashed:", err); process.exit(1); });

/* LIVE end-to-end provisioning smoke — creates a REAL dxFeed user/account/
 * subscription on STAGING, verifies the link, then cleans up what's deletable.
 *
 * Staging is free and meant for exactly this. The trading ACCOUNT and SUBSCRIPTION
 * are torn down at the end; the dxFeed USER persists (there is no delete-user
 * endpoint) — harmless on staging.
 *
 * Run: npx tsx src/dxfeed/provision.smoke.ts
 */

import { getPool } from "../db/pool.js";
import { config, dxfeedReady } from "../config.js";
import { propfirm } from "./propfirm.js";
import { provisionSubscriber } from "./provision.js";
import { getDxFeedLink, deleteDxFeedLink } from "./store.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function main(): Promise<void> {
  console.log(`\ndxFeed provisioning smoke → ${config.dxfeed.propfirmUrl}\n`);
  if (!dxfeedReady) { console.error("DXFEED_API_KEY not set."); process.exit(1); }

  const pool = getPool();
  const email = `dxf-smoke-${Date.now()}@example.com`;
  const { rows } = await pool.query(
    `INSERT INTO "signal"."User" ("email","passwordHash","name","role","status")
     VALUES ($1,'x','Smoke Test','SUBSCRIBER','ACTIVE') RETURNING "id"`,
    [email],
  );
  const userId = rows[0].id as string;
  console.log(`  local subscriber ${userId} (${email})`);

  let dxUserId = "", accountId = "", subscriptionId = "";
  try {
    const link = await provisionSubscriber(userId);
    dxUserId = link.dxUserId; accountId = link.dxAccountId ?? ""; subscriptionId = link.dxSubscriptionId ?? "";

    check("dxFeed user created", !!link.dxUserId, JSON.stringify(link.dxUserId));
    check("trading account created", !!link.dxAccountId, JSON.stringify(link.dxAccountId));
    check("subscription created", !!link.dxSubscriptionId, JSON.stringify(link.dxSubscriptionId));

    const stored = await getDxFeedLink(userId);
    check("link persisted locally", stored?.dxAccountId === link.dxAccountId);

    // Idempotency: a second provision must NOT create a second account.
    const again = await provisionSubscriber(userId);
    check("re-provision is a no-op (same account)", again.dxAccountId === link.dxAccountId, `${again.dxAccountId}`);

    console.log("\n  provisioned:");
    console.log(`    dxUserId        ${link.dxUserId}`);
    console.log(`    dxAccountId     ${link.dxAccountId}`);
    console.log(`    dxSubscriptionId${link.dxSubscriptionId}`);
    console.log(`    subStatus       ${link.subscriptionStatus}  agreementSigned=${link.agreementSigned}`);
    if (link.agreementLink) console.log(`    agreementLink   ${link.agreementLink}`);

    if (link.dxAccountId) {
      const info = (await propfirm.getAccountInfo(link.dxAccountId)) as { snapshot?: { balance?: number; equity?: number }; status?: number };
      console.log(`\n  GetAccountInfo → status=${info?.status} balance=${info?.snapshot?.balance} equity=${info?.snapshot?.equity}`);
      check("account info readable", info != null && typeof info === "object");
    }
  } catch (err) {
    check("provisioning completed", false, (err as Error).message);
  } finally {
    // Cleanup (best-effort). Account must be disabled before it can be deleted.
    console.log("\n  cleanup…");
    try { if (accountId) { await propfirm.disableTradingAccount(accountId, "smoke cleanup"); await propfirm.deleteTradingAccount(dxUserId, accountId); console.log("    account disabled + deleted"); } }
    catch (e) { console.log(`    account cleanup warn: ${(e as Error).message}`); }
    try { if (subscriptionId) { await propfirm.deactivateSubscription(subscriptionId); console.log("    subscription deactivated"); } }
    catch (e) { console.log(`    subscription cleanup warn: ${(e as Error).message}`); }
    await deleteDxFeedLink(userId);
    await pool.query(`DELETE FROM "signal"."User" WHERE "id" = $1`, [userId]);
    console.log("    local rows removed");
    if (dxUserId) console.log(`    NOTE: dxFeed user ${dxUserId} persists (no delete-user endpoint) — harmless on staging`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error("smoke crashed:", err); process.exit(1); });

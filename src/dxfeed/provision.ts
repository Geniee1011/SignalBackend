import { getPool } from "../db/pool.js";
import { config } from "../config.js";
import { propfirm } from "./propfirm.js";
import { getDxFeedLink, upsertDxFeedLink, type DxFeedLinkInput } from "./store.js";
import {
  AccountMode, Currency, EncryptionMode, IdReference, UserType,
  type DataFeedProduct, type Platform,
} from "./types.js";

/* Provision a subscriber's dxFeed identity: user → trading account → market-data
 * subscription, all linked back to our signal.User. This is the "single front
 * door" mechanic — the subscriber exists once in our app, and dxFeed is created
 * for them behind the scenes.
 *
 * SAFE TO RETRY. The link row is upserted after EACH dxFeed call, so a failure
 * part-way (or a re-run) resumes from where it stopped instead of creating
 * duplicate accounts. A subscriber who is already fully provisioned is a no-op. */

export interface ProvisionOptions {
  balance?: number;
  /** Challenge-template rule id to attach (defaults to config; empty = no rule). */
  ruleId?: string;
  dataFeedProducts?: number[];
  platform?: number;
}

/** Best-effort split of a display name (or email) into first/last for dxFeed. */
function splitName(name: string | null, email: string): { firstName: string; lastName: string } {
  const raw = (name || email.split("@")[0] || "Trader").trim();
  const parts = raw.split(/\s+/);
  return { firstName: parts[0] || "Trader", lastName: parts.slice(1).join(" ") || parts[0] || "Account" };
}

/* Returns the LINK ONLY. Provisioning deliberately does not confer trade
 * readiness — a fully provisioned account can still silently swallow orders, so
 * that is earned separately via verifyTradeReady() in readiness.ts. */
export async function provisionSubscriber(userId: string, opts: ProvisionOptions = {}): Promise<DxFeedLinkInput> {
  const existing = await getDxFeedLink(userId);
  if (existing?.dxAccountId && existing?.dxSubscriptionId) return existing; // already done

  const { rows } = await getPool().query(
    `SELECT "email","name" FROM "signal"."User" WHERE "id" = $1`,
    [userId],
  );
  if (!rows[0]) throw new Error(`provisionSubscriber: no signal user ${userId}`);
  const email = String(rows[0].email);
  const { firstName, lastName } = splitName(rows[0].name as string | null, email);

  const p = config.dxfeed.provisioning;
  const ruleId = opts.ruleId ?? p.ruleId;
  const link: DxFeedLinkInput = existing ?? {
    userId, dxUserId: "", dxAccountId: null, dxSubscriptionId: null,
    accountStatus: null, subscriptionStatus: null,
    agreementSigned: false, agreementLink: null, platform: null,
  };

  // 1) dxFeed user (upsert by email on their side; we keep the id).
  if (!link.dxUserId) {
    const user = await propfirm.newUser({
      firstName, lastName, email, country: p.country,
      extEntityId: userId, // our id, echoed back for correlation
      encryptionMode: EncryptionMode.NONE,
      userType: UserType.USER,
    });
    if (!user.userId) throw new Error("provisionSubscriber: NewUser returned no userId");
    link.dxUserId = user.userId;
    await upsertDxFeedLink(link);
  }

  // 2) Trading account (enabled, optionally bound to a challenge rule template).
  if (!link.dxAccountId) {
    const acct = await propfirm.createTradingAccount({
      userId: link.dxUserId,
      balance: opts.balance ?? p.balance,
      currency: Currency.USD,
      enabled: true,
      mode: AccountMode.EVALUATION,
      description: `SignalApp ${userId}`,
      ...(ruleId ? { accountRuleReference: IdReference.APPLICATION, accountRuleId: ruleId } : {}),
    });
    if (!acct.accountId) throw new Error("provisionSubscriber: CreateTradingAccount returned no accountId");
    link.dxAccountId = acct.accountId;
    await upsertDxFeedLink(link);
  }

  // 3) Market-data subscription (platform + data-feed entitlements). Its response
  //    carries the data-agreement link the subscriber must sign for real-time data.
  if (!link.dxSubscriptionId) {
    const sub = await propfirm.newSubscription({
      userId: link.dxUserId,
      dataFeedProducts: (opts.dataFeedProducts ?? p.dataFeedProducts) as DataFeedProduct[],
      platform: (opts.platform ?? p.platform) as Platform,
      enabled: true,
    });
    link.dxSubscriptionId = sub.subscriptionId;
    link.subscriptionStatus = sub.status;
    link.agreementLink = sub.dxAgreementLink;
    link.agreementSigned = sub.dxAgreementSigned;
    link.platform = sub.platform;
    await upsertDxFeedLink(link);
  }

  return link;
}

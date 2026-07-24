-- SignalBackend schema. Everything the signal app OWNS lives under the "signal"
-- schema, kept completely separate from the trading platform's tables (public.*).
-- This app only READS the trading tables; it never creates or alters them.
-- Idempotent — safe to run repeatedly (applied by `npm run db:migrate`).

CREATE SCHEMA IF NOT EXISTS "signal";

-- Signal-app customers. A DIFFERENT user base from the trading platform's
-- "public"."User": a trader can never log into the signal app because they have
-- no row here (and the JWT secret differs).
CREATE TABLE IF NOT EXISTS "signal"."User" (
  "id"           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "email"        text UNIQUE NOT NULL,
  "passwordHash" text NOT NULL,
  "name"         text,
  "role"         text NOT NULL DEFAULT 'SUBSCRIBER', -- 'SUBSCRIBER' | 'ADMIN'
  "status"       text NOT NULL DEFAULT 'ACTIVE',     -- 'ACTIVE' | 'SUSPENDED'
  "createdAt"    timestamptz NOT NULL DEFAULT now(),
  "updatedAt"    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "signal_User_email_idx" ON "signal"."User" ("email");

-- Per-user ACCESS configuration (entitlements). Controls which signals each
-- subscriber receives on their live feed. Added as nullable/defaulted columns so
-- the migration is idempotent and safe on an existing table.
--   accessMarkets       text[]  : allowed markets (empty = ALL)  e.g. {NQ,ES}
--   accessDirection     text    : 'LONG' | 'SHORT' | 'BOTH'
--   accessDailyLimit    integer : max signals/day (NULL = unlimited); extra are locked
--   accessMinConviction integer : only deliver conviction >= this (1..4)
--   accessLive          boolean : see ACTIVE (live) signals, or only closed history
--   accessSuspended     boolean : cut the feed entirely (without deleting the user)
--   accessAllocationPercent integer : COPY share of eligible signals (0-100). The
--                                     subscriber still SEES all of them; only the
--                                     copy engine trades this slice, so a fleet of
--                                     accounts doesn't place identical trades. 100 = all.
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessMarkets"       text[]  NOT NULL DEFAULT '{}';
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessDirection"     text    NOT NULL DEFAULT 'BOTH';
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessDailyLimit"    integer;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessMinConviction" integer NOT NULL DEFAULT 1;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessLive"          boolean NOT NULL DEFAULT true;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessSuspended"     boolean NOT NULL DEFAULT false;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessAllocationPercent" integer NOT NULL DEFAULT 100;

-- ---------------------------------------------------------------------------
-- Broker integration (Tradovate). Phase 1 is strictly ONE-TO-ONE: a subscriber
-- links exactly one brokerage account, enforced by the UNIQUE constraint on
-- "userId". Expanding to one-user-many-accounts later means dropping that
-- constraint and adding a "primary" flag — every other column already allows it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "signal"."BrokerLink" (
  "id"            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"        text NOT NULL UNIQUE REFERENCES "signal"."User"("id") ON DELETE CASCADE,
  "broker"        text NOT NULL DEFAULT 'tradovate',
  -- 'demo' | 'live'. Defaults to demo: connecting to a live account must be a
  -- deliberate act, never something a default lands you in.
  "env"           text NOT NULL DEFAULT 'demo',
  -- AES-256-GCM blobs (BROKER_ENC_KEY). The password and API secret are NEVER
  -- stored or logged in plaintext and are never returned over the API.
  "usernameEnc"   text NOT NULL,
  "passwordEnc"   text NOT NULL,
  "cidEnc"        text NOT NULL,
  "secEnc"        text NOT NULL,
  -- Resolved after a successful login; identifies which account orders go to.
  "accountId"     integer,
  "accountSpec"   text,
  "accountName"   text,
  "status"        text NOT NULL DEFAULT 'PENDING',  -- 'PENDING' | 'CONNECTED' | 'ERROR'
  "lastError"     text,
  "lastCheckedAt" timestamptz,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

-- Auto-copy settings. Separate from BrokerLink so a user can keep their broker
-- connected while automation is switched off — disconnecting to pause trading
-- would force them to re-enter credentials.
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyEnabled"       boolean NOT NULL DEFAULT false;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyMinConviction" integer NOT NULL DEFAULT 1;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyMarkets"       text[]  NOT NULL DEFAULT '{}';
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyQuantity"      integer NOT NULL DEFAULT 1;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyMaxConcurrent" integer NOT NULL DEFAULT 3;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyMaxPerDay"     integer NOT NULL DEFAULT 10;

-- Every copy attempt, successful or not. This table is what makes automation
-- SAFE to re-run: the UNIQUE (userId, signalId) pair means a signal can only ever
-- be placed once per user, so a restart, a duplicate broadcast or an overlapping
-- engine tick can never double-fill a live account.
CREATE TABLE IF NOT EXISTS "signal"."CopyOrder" (
  "id"            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"        text NOT NULL REFERENCES "signal"."User"("id") ON DELETE CASCADE,
  "signalId"      text NOT NULL,
  "symbol"        text NOT NULL,
  "contract"      text,
  "side"          text NOT NULL,             -- signal side: 'LONG' | 'SHORT'
  "quantity"      integer NOT NULL,
  "status"        text NOT NULL,             -- 'PLACED' | 'REJECTED' | 'SKIPPED'
  "brokerOrderId" text,
  "reason"        text,                      -- rejection cause / skip reason
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CopyOrder_user_signal_key" UNIQUE ("userId", "signalId")
);
CREATE INDEX IF NOT EXISTS "signal_CopyOrder_user_idx" ON "signal"."CopyOrder" ("userId", "createdAt" DESC);

-- Three-way copy mode, superseding the boolean "copyEnabled" (kept in sync for
-- any older reader). 'confirm' prepares an order but waits for the user to
-- approve it — required wherever automation is only permitted with active human
-- oversight.
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyMode" text NOT NULL DEFAULT 'off';

-- CopyOrder gains the queue/confirm lifecycle:
--   PENDING_CONFIRM -> user must approve  |  QUEUED -> awaiting their terminal
--   PLACED / REJECTED / SKIPPED           -> terminal states
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "adapter"     text;
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "stopLoss"    numeric(18,6);
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "takeProfit"  numeric(18,6);
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "conviction"  integer;
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "claimedAt"   timestamptz;
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "updatedAt"   timestamptz NOT NULL DEFAULT now();

-- The signal's entry price, carried through so the terminal can work the entry as
-- a LIMIT order at the price the signal was published at, rather than paying
-- whatever the market offers. A market entry fills at any price, which in a fast
-- market is exactly where a copied result stops resembling the advertised one.
-- NULL = no price known; the terminal falls back to a market entry.
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "limitPrice"  numeric(18,6);

-- Copy orders are now either an ENTRY or a CLOSE (mirroring the trader exiting).
-- 'kind' defaults to ENTRY so every existing row keeps its meaning.
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'ENTRY';

-- The UNIQUE(userId, signalId) guard stops a signal being ENTERED twice — but a
-- CLOSE for that same signal must still be allowed through. Widening the key to
-- include 'kind' permits exactly one entry AND one close per signal, per user,
-- and nothing more.
ALTER TABLE "signal"."CopyOrder" DROP CONSTRAINT IF EXISTS "CopyOrder_user_signal_key";
CREATE UNIQUE INDEX IF NOT EXISTS "CopyOrder_user_signal_kind_key"
  ON "signal"."CopyOrder" ("userId", "signalId", "kind");

-- DRY_RUN: the terminal deliberately did not place this because it is in
-- log-only mode. Distinct from SKIPPED (a filter/limit stopped it) and REJECTED
-- (the broker refused it), because a DRY_RUN entry represents a position that
-- WOULD exist — so it must still generate a CLOSE. Without this, log-only mode
-- could exercise entries but never exits, and close bugs would only surface
-- once real money was on the line.
COMMENT ON COLUMN "signal"."CopyOrder"."status" IS
  'PENDING_CONFIRM | QUEUED | PLACED | DRY_RUN | REJECTED | SKIPPED | EXPIRED | ABANDONED';

-- Global key/value settings for the signal service (admin-configured). Currently
-- holds the conviction->risk map that drives position sizing; a table rather than
-- env vars because the admin edits it live from the dashboard.
CREATE TABLE IF NOT EXISTS "signal"."AppSetting" (
  "key"       text PRIMARY KEY,
  "value"     jsonb NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

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
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessMarkets"       text[]  NOT NULL DEFAULT '{}';
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessDirection"     text    NOT NULL DEFAULT 'BOTH';
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessDailyLimit"    integer;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessMinConviction" integer NOT NULL DEFAULT 1;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessLive"          boolean NOT NULL DEFAULT true;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessSuspended"     boolean NOT NULL DEFAULT false;

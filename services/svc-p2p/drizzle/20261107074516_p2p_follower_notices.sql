-- P-ads-merchant-22 (J-p2p-12 #4): a person who follows a trader is told, once, when that trader posts a new public ad.
-- `follower_notices` is the outbox of those notices: one row per (ad, follower), written in the same transaction that
-- posts the ad, so each notice is owed from the commit and owed once. An edit of the ad writes nothing. `handed_at` says
-- when `p2p.trader.posted` reached the bus; while it is null the sweep hands it over again (the bus and svc-notify dedupe
-- on the ad and the follower). The owner's daily figure bounds how many ads a day reach a trader's followers; blank
-- sends none. No balance is stored here.
-- Reversal: 20261107074516_p2p_follower_notices.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."follower_notices" (
  "offer_id" uuid NOT NULL REFERENCES "p2p"."offers" ("id") ON DELETE CASCADE,
  "follower_id" text NOT NULL,
  "trader_id" text NOT NULL,
  "posted_at" timestamptz NOT NULL,
  "handed_at" timestamptz,
  -- Set instead of handing over when, by hand-over time, the pair has blocked each other or the ad is no longer up.
  "dropped_at" timestamptz,
  CONSTRAINT "follower_notices_pk" PRIMARY KEY ("offer_id", "follower_id"),
  CONSTRAINT "follower_notices_self_ck" CHECK ("follower_id" <> "trader_id"),
  CONSTRAINT "follower_notices_order_ck" CHECK ("handed_at" IS NULL OR "handed_at" >= "posted_at")
);

CREATE INDEX IF NOT EXISTS "follower_notices_owed_idx"
  ON "p2p"."follower_notices" ("posted_at")
  WHERE "handed_at" IS NULL AND "dropped_at" IS NULL;

CREATE INDEX IF NOT EXISTS "follower_notices_trader_idx"
  ON "p2p"."follower_notices" ("trader_id", "posted_at");

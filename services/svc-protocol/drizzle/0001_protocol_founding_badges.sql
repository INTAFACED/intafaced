-- svc-protocol · founding badges (RC-more-catalogue-04)
-- Reversal: 0001_protocol_founding_badges.down.sql
--
-- No balance and no money: a founder-written eligibility list and the record of
-- one NFT mint per account. The chain holds the badge itself.

CREATE TABLE IF NOT EXISTS "protocol"."founding_badge_list" (
  "account_id" uuid PRIMARY KEY,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "protocol"."founding_badge_claims" (
  -- Business key `badge:claim:<account>`; one claim per account.
  "key"        text PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "chain_id"   integer NOT NULL,
  "to_address" text NOT NULL,
  -- Null between "claim stored" and "mint submitted"; a retry reuses it once set.
  "tx_hash"    text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "founding_badge_claims_account_idx"
  ON "protocol"."founding_badge_claims" ("account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "founding_badge_claims_chain_address_idx"
  ON "protocol"."founding_badge_claims" ("chain_id", "to_address");

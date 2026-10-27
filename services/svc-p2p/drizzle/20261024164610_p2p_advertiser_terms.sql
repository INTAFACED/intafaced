-- P-ads-merchant-01: the P2P advertiser terms a person accepted before posting an ad, by version.
-- One row per person and version, written once: accepting again changes nothing.
-- The version is owner-published (P2P_ADVERTISER_TERMS_VERSION); posting an ad refuses until
-- the current version has a row. No balance is stored here.
-- Reversal: 20261024164610_p2p_advertiser_terms.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."advertiser_terms_acceptances" (
  "user_id" text NOT NULL,
  "version" text NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "advertiser_terms_acceptances_pk" PRIMARY KEY ("user_id", "version"),
  CONSTRAINT "advertiser_terms_acceptances_version_ck" CHECK (length(btrim("version")) BETWEEN 1 AND 64)
);

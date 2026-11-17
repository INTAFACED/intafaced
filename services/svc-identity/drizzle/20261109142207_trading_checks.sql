-- svc-identity · the trading checks (J-cex-spot-01 #3, OWNER 258 (4)): trading-only users get a country and sanctions
-- check, with no ID document, selfie or ID vendor. The check screens the legal name they give, with the date of birth
-- and the country they gave at sign-up, against the owner's sanctions list (IDENTITY_SANCTIONS_PERSONS_LIST, NO DEFAULT).
--
-- birth_dates: the date of birth a person gave at sign-up, sealed under the KYC document key (AES-256-GCM, the same key
-- as kyc_documents); never plaintext. signup_drafts carries it sealed between the two sign-up steps. A sign-up with the
-- key unset keeps no date of birth, and the trading checks then refuse kyc.date_of_birth_unknown.
--
-- trading_checks: one row per person, keyed by its business key (kyc:trading-checks:<user id>), so a repeat answers the
-- first outcome and never screens again. "cleared" opens a level-basic record for trading only (reviewed_by
-- 'trading-checks'); "held" opens a pending record for a person in compliance to review, and grants nothing. The legal
-- name is sealed under the same key. A refusal (a blank list, an unknown date of birth) writes nothing here.
--
-- Reversal: 20261109142207_trading_checks.down.sql
ALTER TABLE "identity"."signup_drafts" ADD COLUMN IF NOT EXISTS "birth_ciphertext" bytea;
ALTER TABLE "identity"."signup_drafts" ADD COLUMN IF NOT EXISTS "birth_nonce" bytea;

CREATE TABLE IF NOT EXISTS "identity"."birth_dates" (
  "user_id"    uuid PRIMARY KEY REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "ciphertext" bytea NOT NULL,
  "nonce"      bytea NOT NULL,
  "key_id"     text NOT NULL DEFAULT 'v1',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "identity"."trading_checks" (
  "user_id"         uuid PRIMARY KEY REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "business_key"    text NOT NULL UNIQUE,
  "outcome"         text NOT NULL CHECK ("outcome" IN ('cleared', 'held')),
  "country"         text NOT NULL CHECK ("country" ~ '^[A-Z]{2}$'),
  "record_id"       uuid NOT NULL,
  "name_ciphertext" bytea NOT NULL,
  "name_nonce"      bytea NOT NULL,
  "key_id"          text NOT NULL DEFAULT 'v1',
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

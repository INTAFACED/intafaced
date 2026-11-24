-- svc-bank · 3D Secure challenges and card fraud reports (J-bank-14 #5, #7; BK-cpay-01)
-- Reversal: 20261109180000_card_3ds_fraud.down.sql
--
-- card_3ds_challenges: one row per challenge the issuer asked the cardholder to answer for an online purchase. The code
-- is the card partner's (its access control server); this row never holds it, only how many wrong codes were entered.
-- 'approved' completes the purchase's authorisation once, under the business key '3ds:<challenge_ref>'; 'locked' is the
-- owner's count of wrong codes reached, and no authorisation is made. Nothing here is a balance and no value moves.
--
-- card_fraud_reports: one report per card payment the cardholder says they did not make. Filing it freezes the card and
-- opens the case; filing again returns the same case. Nothing here moves money.

CREATE TABLE IF NOT EXISTS "bank"."card_3ds_challenges" (
  "id"                uuid PRIMARY KEY,
  "card_id"           uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "user_id"           text NOT NULL,
  "challenge_ref"     text NOT NULL,
  "amount"            text NOT NULL,
  "merchant"          text,
  "merchant_country"  text,
  "merchant_category" text,
  "state"             text NOT NULL DEFAULT 'open',
  "wrong_codes"       integer NOT NULL DEFAULT 0,
  "authorization_id"  uuid,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "decided_at"        timestamptz,
  CONSTRAINT "card_3ds_challenges_state_ck" CHECK ("state" IN ('open', 'approved', 'locked')),
  CONSTRAINT "card_3ds_challenges_wrong_ck" CHECK ("wrong_codes" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "card_3ds_challenges_ref_uq" ON "bank"."card_3ds_challenges" ("card_id", "challenge_ref");

CREATE TABLE IF NOT EXISTS "bank"."card_fraud_reports" (
  "id"                uuid PRIMARY KEY,
  "card_id"           uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "user_id"           text NOT NULL,
  "authorization_id"  uuid NOT NULL,
  "state"             text NOT NULL DEFAULT 'open',
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "card_fraud_reports_state_ck" CHECK ("state" IN ('open'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "card_fraud_reports_authorization_uq" ON "bank"."card_fraud_reports" ("authorization_id");

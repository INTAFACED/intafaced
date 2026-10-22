-- Sub-account sign-in control and account switching (I-account-lifecycle-04). Sign-in for a sub-account is off by
-- default; each change is audited. Every switch from the main account into a sub-account is recorded (the owner's
-- minimum interval reads the last one). No balance, no ledger.
-- Reversal: 0070_sub_account_signin_switch.down.sql

ALTER TABLE "identity"."sub_accounts" ADD COLUMN IF NOT EXISTS "signin_enabled" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "identity"."sub_account_signin_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sub_account_id" uuid NOT NULL REFERENCES "identity"."sub_accounts" ("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "session_id" text NOT NULL,
  "enabled" boolean NOT NULL,
  "at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS "sub_account_signin_audit_sub_idx" ON "identity"."sub_account_signin_audit" ("sub_account_id", "at" DESC);

CREATE TABLE IF NOT EXISTS "identity"."sub_account_switches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "sub_account_id" uuid NOT NULL REFERENCES "identity"."sub_accounts" ("id") ON DELETE CASCADE,
  "session_id" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS "sub_account_switches_user_idx" ON "identity"."sub_account_switches" ("user_id", "at" DESC);

-- Account product tiers (J-ops-console-04 #11). Which tier an account is on, with its own version for the move's
-- four-eyes approval; the tiers and their terms are an owner setting (IDENTITY_ACCOUNT_TIERS), not rows here. No row:
-- the account was never put on a tier. The move history is kept in founder_control_audit under its own kind.
-- Reversal: 0070_account_tiers.down.sql

CREATE TABLE IF NOT EXISTS "identity"."account_tier_assignments" (
  "user_id" uuid PRIMARY KEY REFERENCES "identity"."users" ("id"),
  "tier_id" text NOT NULL CHECK ("tier_id" ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  "version" bigint NOT NULL CHECK ("version" > 0),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "identity"."founder_control_audit" DROP CONSTRAINT IF EXISTS "founder_control_audit_kind_check";
ALTER TABLE "identity"."founder_control_audit"
  ADD CONSTRAINT "founder_control_audit_kind_check" CHECK ("kind" IN ('identity', 'entitlement', 'bootstrap', 'closure', 'tier'));

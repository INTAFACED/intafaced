-- Trading features a main account turns on for one of its sub-accounts (W-security-accounts-06).
-- A row means "enabled". Enabling twice is one row. Which features each sub-account kind may have is an owner setting
-- (IDENTITY_SUB_ACCOUNT_FEATURES), not stored here. Reversal: 0062_sub_account_features.down.sql

CREATE TABLE IF NOT EXISTS "identity"."sub_account_features" (
  "sub_account_id" uuid NOT NULL REFERENCES "identity"."sub_accounts" ("id") ON DELETE CASCADE,
  "feature" text NOT NULL CHECK ("feature" IN ('spot', 'convert', 'futures', 'algo', 'copy')),
  "enabled_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("sub_account_id", "feature")
);

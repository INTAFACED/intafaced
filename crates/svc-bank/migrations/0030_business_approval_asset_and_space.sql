-- 0011 did not tie business_approvals.asset_id to the account asset, and it
-- allowed from_space_id = to_space_id. A database that already applied that
-- 0011 gains the three constraints here. A fresh 0011 already created them, so
-- each add runs only when pg_constraint does not already have that name.
-- This file does not update, delete, or insert any row.
--
-- Reversal: 0030_business_approval_asset_and_space.down.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'business_accounts_id_asset_key'
  ) THEN
    ALTER TABLE "bank"."business_accounts"
      ADD CONSTRAINT "business_accounts_id_asset_key" UNIQUE ("id", "asset_id");
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'business_approvals_account_asset_fk'
  ) THEN
    ALTER TABLE "bank"."business_approvals"
      ADD CONSTRAINT "business_approvals_account_asset_fk"
      FOREIGN KEY ("account_id", "asset_id") REFERENCES "bank"."business_accounts" ("id", "asset_id");
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'business_approvals_spaces_distinct'
  ) THEN
    ALTER TABLE "bank"."business_approvals"
      ADD CONSTRAINT "business_approvals_spaces_distinct"
      CHECK ("from_space_id" <> "to_space_id");
  END IF;
END
$$;

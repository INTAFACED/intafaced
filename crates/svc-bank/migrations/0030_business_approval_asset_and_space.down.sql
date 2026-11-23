-- The asset foreign key depends on business_accounts_id_asset_key, so it goes first.
ALTER TABLE "bank"."business_approvals" DROP CONSTRAINT IF EXISTS "business_approvals_account_asset_fk";
ALTER TABLE "bank"."business_approvals" DROP CONSTRAINT IF EXISTS "business_approvals_spaces_distinct";
ALTER TABLE "bank"."business_accounts" DROP CONSTRAINT IF EXISTS "business_accounts_id_asset_key";

-- intafaced:destructive — reversal of 0082_pay_merchant_business_profile.sql
--
-- Drops the business-profile columns and the change log. Display and legal names
-- from 0071 stay. No ledger row is touched.

DROP INDEX IF EXISTS "pay"."merchant_profile_changes_one_pending";
DROP INDEX IF EXISTS "pay"."merchant_profile_changes_merchant_idx";
DROP INDEX IF EXISTS "pay"."merchant_profile_changes_seq_idx";
DROP TABLE IF EXISTS "pay"."merchant_profile_changes";

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_address_ck";
ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_industry_ck";
ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_statement_descriptor_ck";
ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_support_phone_ck";
ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_support_email_ck";
ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_website_ck";
ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_profile_version_ck";

ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "address_country";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "address_postal_code";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "address_region";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "address_city";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "address_line2";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "address_line1";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "industry";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "statement_descriptor";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "support_phone";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "support_email";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "website";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "profile_version";

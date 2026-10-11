-- loan_products.min_principal DEFAULT 0 stores an allow-all floor when an
-- insert omits the limit. A blank limit is null. An explicit number,
-- including 0, stays that number.
--
-- DROP DEFAULT and DROP NOT NULL only. Stored rows keep the floor they
-- already have.
--
-- A present value stays non-negative. Null passes the check.
--
-- Reversal: 0021_loan_floor_blank.down.sql

ALTER TABLE "bank"."loan_products" ALTER COLUMN "min_principal" DROP DEFAULT;
ALTER TABLE "bank"."loan_products" ALTER COLUMN "min_principal" DROP NOT NULL;

ALTER TABLE "bank"."loan_products" DROP CONSTRAINT IF EXISTS "loan_products_min_principal_non_negative_ck";
ALTER TABLE "bank"."loan_products" ADD CONSTRAINT "loan_products_min_principal_non_negative_ck"
  CHECK ("min_principal" IS NULL OR "min_principal" >= 0);

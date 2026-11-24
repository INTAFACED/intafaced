-- intafaced:destructive — drops the DEFAULT 0 and the NOT NULL on bank.loan_products.min_principal
-- (and re-creates its non-negative CHECK under the same name). Invariants are relaxed, not data:
-- no row is deleted or rewritten, and a stored floor keeps its value. Intended: a blank limit
-- must stay blank instead of silently becoming an allow-all floor of 0. Reversal: the .down.sql.
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

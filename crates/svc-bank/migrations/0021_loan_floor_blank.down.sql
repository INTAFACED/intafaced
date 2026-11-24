-- Restore the pre-0021 default and the NOT NULL. Stored rows are not rewritten.
-- SET NOT NULL fails if a blank floor is already stored.
-- The non-negative check did not exist before 0021.

ALTER TABLE "bank"."loan_products" ALTER COLUMN "min_principal" SET DEFAULT 0;

ALTER TABLE "bank"."loan_products" DROP CONSTRAINT IF EXISTS "loan_products_min_principal_non_negative_ck";

ALTER TABLE "bank"."loan_products" ALTER COLUMN "min_principal" SET NOT NULL;

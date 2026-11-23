ALTER TABLE "bank"."loans" DROP CONSTRAINT IF EXISTS "loans_opening_collateral_positive";
ALTER TABLE "bank"."loans" DROP COLUMN IF EXISTS "opening_collateral";

ALTER TABLE "bank"."loans" DROP CONSTRAINT IF EXISTS "loans_terms_bps_bounded";
ALTER TABLE "bank"."loans" DROP CONSTRAINT IF EXISTS "loans_terms_ordered";

ALTER TABLE "bank"."loans" ALTER COLUMN "margin_call_ltv_bps" DROP NOT NULL;
ALTER TABLE "bank"."loans" ALTER COLUMN "liquidation_ltv_bps" DROP NOT NULL;

ALTER TABLE "bank"."loans" DROP COLUMN IF EXISTS "grace_seconds";
ALTER TABLE "bank"."loans" DROP COLUMN IF EXISTS "max_tranche_bps";
ALTER TABLE "bank"."loans" DROP COLUMN IF EXISTS "penalty_bps";
ALTER TABLE "bank"."loans" DROP COLUMN IF EXISTS "target_ltv_bps";
ALTER TABLE "bank"."loans" DROP COLUMN IF EXISTS "insolvency_ltv_bps";
ALTER TABLE "bank"."loans" DROP COLUMN IF EXISTS "max_ltv_bps";

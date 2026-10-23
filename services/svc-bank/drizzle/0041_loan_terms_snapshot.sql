-- svc-bank — loan terms are snapshotted at open
--
-- The risk sweep, seize, margin call, penalty and excess-release cap read the
-- live product row. A product edit re-banded every open loan. APR and the two
-- LTV lines already copied onto the loan were not what those paths read.
-- These columns are the rest of the ladder the borrower agreed to. open()
-- writes them once. A later product edit does not update them.
--
-- Backfill: every loan whose snapshot is still blank is copied from its
-- product row as that row stands at this migration, in one statement, so the
-- bands stay one coherent set. That includes open loans (pending, active,
-- margin_call, liquidating), which are the rows the sweep reads, and terminal
-- loans so the columns can be NOT NULL. The statement does not run again, so
-- a product edit after this file does not move an existing loan.
--
-- Reversal: 0041_loan_terms_snapshot.down.sql

ALTER TABLE "bank"."loans" ADD COLUMN IF NOT EXISTS "max_ltv_bps" integer;
ALTER TABLE "bank"."loans" ADD COLUMN IF NOT EXISTS "insolvency_ltv_bps" integer;
ALTER TABLE "bank"."loans" ADD COLUMN IF NOT EXISTS "target_ltv_bps" integer;
ALTER TABLE "bank"."loans" ADD COLUMN IF NOT EXISTS "penalty_bps" integer;
ALTER TABLE "bank"."loans" ADD COLUMN IF NOT EXISTS "max_tranche_bps" integer;
ALTER TABLE "bank"."loans" ADD COLUMN IF NOT EXISTS "grace_seconds" integer;

UPDATE "bank"."loans" AS l
   SET "max_ltv_bps" = p."max_ltv_bps",
       "margin_call_ltv_bps" = p."margin_call_ltv_bps",
       "liquidation_ltv_bps" = p."liquidation_ltv_bps",
       "insolvency_ltv_bps" = p."insolvency_ltv_bps",
       "target_ltv_bps" = p."target_ltv_bps",
       "penalty_bps" = p."penalty_bps",
       "max_tranche_bps" = p."max_tranche_bps",
       "grace_seconds" = p."grace_seconds"
  FROM "bank"."loan_products" AS p
 WHERE l."product_id" = p."id"
   AND l."max_ltv_bps" IS NULL;

ALTER TABLE "bank"."loans" ALTER COLUMN "max_ltv_bps" SET NOT NULL;
ALTER TABLE "bank"."loans" ALTER COLUMN "margin_call_ltv_bps" SET NOT NULL;
ALTER TABLE "bank"."loans" ALTER COLUMN "liquidation_ltv_bps" SET NOT NULL;
ALTER TABLE "bank"."loans" ALTER COLUMN "insolvency_ltv_bps" SET NOT NULL;
ALTER TABLE "bank"."loans" ALTER COLUMN "target_ltv_bps" SET NOT NULL;
ALTER TABLE "bank"."loans" ALTER COLUMN "penalty_bps" SET NOT NULL;
ALTER TABLE "bank"."loans" ALTER COLUMN "max_tranche_bps" SET NOT NULL;
ALTER TABLE "bank"."loans" ALTER COLUMN "grace_seconds" SET NOT NULL;

ALTER TABLE "bank"."loans" DROP CONSTRAINT IF EXISTS "loans_terms_ordered";
ALTER TABLE "bank"."loans"
  ADD CONSTRAINT "loans_terms_ordered" CHECK (
    "max_ltv_bps" > 0
    AND "target_ltv_bps" < "margin_call_ltv_bps"
    AND "max_ltv_bps" < "margin_call_ltv_bps"
    AND "margin_call_ltv_bps" < "liquidation_ltv_bps"
    AND "liquidation_ltv_bps" <= "insolvency_ltv_bps"
  );

ALTER TABLE "bank"."loans" DROP CONSTRAINT IF EXISTS "loans_terms_bps_bounded";
ALTER TABLE "bank"."loans"
  ADD CONSTRAINT "loans_terms_bps_bounded" CHECK (
    "penalty_bps" >= 0 AND "penalty_bps" <= 10000
    AND "max_tranche_bps" > 0 AND "max_tranche_bps" <= 10000
    AND "grace_seconds" >= 0
  );

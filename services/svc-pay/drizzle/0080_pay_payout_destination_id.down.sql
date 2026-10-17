DROP TABLE IF EXISTS "pay"."merchant_statement_leases";

DROP INDEX IF EXISTS "pay"."merchant_payout_destinations_id_idx";

ALTER TABLE "pay"."merchant_payout_destinations"
  ALTER COLUMN "id" DROP DEFAULT;

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP COLUMN IF EXISTS "id";

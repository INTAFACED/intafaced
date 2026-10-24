-- Drops the announcement record. Nothing about money is lost: the ledger post and the deposit row are unchanged.
DROP INDEX IF EXISTS "pay"."custody_deposits_unannounced_idx";
ALTER TABLE "pay"."custody_deposits" DROP COLUMN IF EXISTS "credit_notified_at";

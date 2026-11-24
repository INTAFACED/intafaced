-- intafaced:destructive drops the notice outbox columns; a posted send not yet announced is then never announced
DROP INDEX IF EXISTS "bank"."personal_transfers_unannounced_idx";
ALTER TABLE "bank"."personal_transfers" DROP COLUMN IF EXISTS "announced_at";
ALTER TABLE "bank"."personal_transfers" DROP COLUMN IF EXISTS "posted_at";

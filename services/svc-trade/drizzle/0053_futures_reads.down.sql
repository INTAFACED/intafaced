-- Reverses 0053_futures_reads.sql.

DROP TABLE IF EXISTS "trade"."futures_mark_samples";

ALTER TABLE "trade"."markets" DROP CONSTRAINT IF EXISTS "markets_test_fixture_ck";
ALTER TABLE "trade"."markets" DROP COLUMN IF EXISTS "test_fixture";
ALTER TABLE "trade"."markets" DROP COLUMN IF EXISTS "test";

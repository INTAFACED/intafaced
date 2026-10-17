-- Futures desk reads: a local TEST swap listing, and stored mark samples for 24h change.
-- Reversal: 0053_futures_reads.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by FUTREADSBE before this file was written.
--
-- `test` defaults false. A production row stays a production row. The TEST seed
-- is the only writer that sets it, and GET /markets hides those rows unless
-- TRADE_FUTURES_TEST_SEED is on. test_fixture holds the leverage cap, mark feed
-- and liquidation policy the seed was given. It is never a production default.
--
-- futures_mark_samples stores marks the service already observed. A 24h change
-- is the difference of two stored samples. No sample at or before now-24h means
-- the history does not cover a day, and the ticker returns null.

ALTER TABLE "trade"."markets"
  ADD COLUMN IF NOT EXISTS "test" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "test_fixture" jsonb;

ALTER TABLE "trade"."markets" DROP CONSTRAINT IF EXISTS "markets_test_fixture_ck";
ALTER TABLE "trade"."markets" ADD CONSTRAINT "markets_test_fixture_ck"
  CHECK (("test" = false AND "test_fixture" IS NULL) OR ("test" = true AND "test_fixture" IS NOT NULL));

CREATE TABLE IF NOT EXISTS "trade"."futures_mark_samples" (
  "market_id"   uuid NOT NULL REFERENCES "trade"."markets" ("id") ON DELETE CASCADE,
  "price"       numeric(38, 18) NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "source"      text NOT NULL,
  PRIMARY KEY ("market_id", "observed_at")
);

ALTER TABLE "trade"."futures_mark_samples" DROP CONSTRAINT IF EXISTS "futures_mark_samples_price_positive_ck";
ALTER TABLE "trade"."futures_mark_samples" ADD CONSTRAINT "futures_mark_samples_price_positive_ck"
  CHECK ("price" > 0 AND length("source") > 0);

CREATE INDEX IF NOT EXISTS "futures_mark_samples_market_observed_idx"
  ON "trade"."futures_mark_samples" ("market_id", "observed_at" DESC);

-- Reverses 0052_futures_desk.sql.
-- SET NOT NULL fails if any row has a null leverage. That is deliberate:
-- filling those rows with 1 would invent a leverage the down path must not.

DROP TABLE IF EXISTS "trade"."account_position_modes";
DROP TABLE IF EXISTS "trade"."futures_open_requests";
DROP TABLE IF EXISTS "trade"."position_close_batches";
DROP TABLE IF EXISTS "trade"."position_close_intents";

DROP INDEX IF EXISTS "trade"."positions_user_client_open_idx";

ALTER TABLE "trade"."positions"
  ALTER COLUMN "leverage" SET DEFAULT 1;

ALTER TABLE "trade"."positions"
  ALTER COLUMN "leverage" SET NOT NULL;

ALTER TABLE "trade"."positions"
  DROP COLUMN IF EXISTS "client_open_id";

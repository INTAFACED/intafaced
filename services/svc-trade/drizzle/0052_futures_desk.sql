-- Futures desk: client open id, nullable legacy leverage, close intents, batches, open requests, account mode.
-- Reversal: 0052_futures_desk.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by FUTDESKBE before this file was written.

ALTER TABLE "trade"."positions"
  ADD COLUMN IF NOT EXISTS "client_open_id" text;

CREATE INDEX IF NOT EXISTS "positions_user_client_open_idx"
  ON "trade"."positions" ("user_id", "client_open_id")
  WHERE "client_open_id" IS NOT NULL;

-- Legacy rows may have no recorded leverage. Dropping the default stops new
-- inserts from inventing 1. Existing values stay as they were written.
ALTER TABLE "trade"."positions"
  ALTER COLUMN "leverage" DROP NOT NULL,
  ALTER COLUMN "leverage" DROP DEFAULT;

CREATE TABLE IF NOT EXISTS "trade"."position_close_intents" (
  "user_id" text NOT NULL,
  "client_close_id" text NOT NULL,
  "position_id" uuid NOT NULL,
  "quantity" numeric(38, 18) NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "client_close_id")
);

CREATE TABLE IF NOT EXISTS "trade"."position_close_batches" (
  "user_id" text NOT NULL,
  "client_batch_id" text NOT NULL,
  "market" text,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "client_batch_id")
);

CREATE TABLE IF NOT EXISTS "trade"."futures_open_requests" (
  "user_id" text NOT NULL,
  "market_id" uuid NOT NULL,
  "client_open_id" text NOT NULL,
  "reduce_only" boolean NOT NULL,
  "outcome" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "market_id", "client_open_id")
);

CREATE TABLE IF NOT EXISTS "trade"."account_position_modes" (
  "user_id" text PRIMARY KEY,
  "mode" text NOT NULL CHECK ("mode" IN ('one_way', 'hedge')),
  "source" text NOT NULL,
  "client_mode_id" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

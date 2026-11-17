-- trade.venue_statement_exports · a statement of one venue account's orders, trades and money movements for a date range,
-- read from the venue's own records (J-cex-spot-07 #5, the launch model: our ledger holds none of the person's money)
-- Reversal: 20261116120000_venue_statement_exports.down.sql
--
-- One job per (person, request key): asking again with the same key answers the same job, never a second file. The file
-- is built once from the range [range_from, range_to), which must be over when asked, and kept with its SHA-256. An export
-- moves no money and signs nothing.

CREATE TABLE IF NOT EXISTS "trade"."venue_statement_exports" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        uuid NOT NULL,
  "request_key"    text NOT NULL,
  "venue_id"       text NOT NULL,
  "owner"          text NOT NULL,
  "range_from"     timestamptz NOT NULL,
  "range_to"       timestamptz NOT NULL,
  "status"         text NOT NULL DEFAULT 'pending',
  "file"           text,
  "sha256"         text,
  "order_rows"     integer,
  "trade_rows"     integer,
  "movement_rows"  integer,
  "error_code"     text,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "finished_at"    timestamptz,
  CONSTRAINT "venue_statement_exports_key_uq" UNIQUE ("user_id", "request_key"),
  CONSTRAINT "venue_statement_exports_range_ck" CHECK ("range_to" > "range_from"),
  CONSTRAINT "venue_statement_exports_key_ck" CHECK (char_length("request_key") BETWEEN 8 AND 128),
  CONSTRAINT "venue_statement_exports_owner_ck" CHECK ("owner" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "venue_statement_exports_state_ck" CHECK (
    ("status" = 'pending' AND "file" IS NULL AND "sha256" IS NULL AND "error_code" IS NULL AND "finished_at" IS NULL)
    OR ("status" = 'finished' AND "file" IS NOT NULL AND "sha256" ~ '^[0-9a-f]{64}$' AND "error_code" IS NULL
        AND "order_rows" >= 0 AND "trade_rows" >= 0 AND "movement_rows" >= 0 AND "finished_at" IS NOT NULL)
    OR ("status" = 'failed' AND "file" IS NULL AND "error_code" IS NOT NULL AND "finished_at" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "venue_statement_exports_user_created_idx"
  ON "trade"."venue_statement_exports" ("user_id", "created_at" DESC);

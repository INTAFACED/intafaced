-- trade.statement_exports · a statement of one person's orders, trades and ledger lines for a date range (J-cex-spot-07 #5)
-- Reversal: 0101_statement_exports.down.sql
--
-- One job per (person, request key): asking again with the same key answers the same job, never a second file. The file
-- is built once from the range [range_from, range_to), which must be over when asked, and kept with its SHA-256. An export
-- moves no money: it reads this service's orders and fills and the ledger's lines for the person's own accounts.

CREATE TABLE IF NOT EXISTS "trade"."statement_exports" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       uuid NOT NULL,
  "request_key"   text NOT NULL,
  "range_from"    timestamptz NOT NULL,
  "range_to"      timestamptz NOT NULL,
  "status"        text NOT NULL DEFAULT 'pending',
  "file"          text,
  "sha256"        text,
  "order_rows"    integer,
  "trade_rows"    integer,
  "ledger_rows"   integer,
  "error_code"    text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "finished_at"   timestamptz,
  CONSTRAINT "statement_exports_key_uq" UNIQUE ("user_id", "request_key"),
  CONSTRAINT "statement_exports_range_ck" CHECK ("range_to" > "range_from"),
  CONSTRAINT "statement_exports_key_ck" CHECK (char_length("request_key") BETWEEN 8 AND 128),
  CONSTRAINT "statement_exports_state_ck" CHECK (
    ("status" = 'pending' AND "file" IS NULL AND "sha256" IS NULL AND "error_code" IS NULL AND "finished_at" IS NULL)
    OR ("status" = 'finished' AND "file" IS NOT NULL AND "sha256" ~ '^[0-9a-f]{64}$' AND "error_code" IS NULL
        AND "order_rows" >= 0 AND "trade_rows" >= 0 AND "ledger_rows" >= 0 AND "finished_at" IS NOT NULL)
    OR ("status" = 'failed' AND "file" IS NULL AND "error_code" IS NOT NULL AND "finished_at" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "statement_exports_user_created_idx" ON "trade"."statement_exports" ("user_id", "created_at" DESC);

-- Historical market data downloads (RC-cex-spot-05; J-cex-spot-15 #10).
-- Public market data only: no account identifier, no order id.

CREATE TABLE IF NOT EXISTS trade.history_book_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES trade.markets(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  sequence bigint NOT NULL,
  captured_at timestamptz NOT NULL,
  bids jsonb NOT NULL,
  asks jsonb NOT NULL,
  CONSTRAINT history_book_snapshots_market_seq_at_uq UNIQUE (market_id, sequence, captured_at)
);

CREATE INDEX IF NOT EXISTS history_book_snapshots_market_captured_idx
  ON trade.history_book_snapshots (market_id, captured_at);

CREATE TABLE IF NOT EXISTS trade.history_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_key text NOT NULL UNIQUE,
  market_id uuid NOT NULL REFERENCES trade.markets(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('trades', 'candles', 'book_snapshots')),
  day text NOT NULL CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  schema_version text NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  byte_length integer NOT NULL CHECK (byte_length >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  first_sequence bigint,
  last_sequence bigint,
  completeness_pct numeric(5, 2) NOT NULL,
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance text NOT NULL,
  payload_gzip bytea NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS history_datasets_symbol_kind_day_idx
  ON trade.history_datasets (symbol, kind, day DESC);

CREATE TABLE IF NOT EXISTS trade.history_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES trade.history_datasets(id) ON DELETE RESTRICT,
  sequence_from bigint NOT NULL,
  sequence_to bigint NOT NULL,
  reason text NOT NULL,
  superseding_dataset_id uuid NOT NULL REFERENCES trade.history_datasets(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT history_corrections_seq_order_ck CHECK (sequence_from <= sequence_to),
  CONSTRAINT history_corrections_dataset_range_sup_uq UNIQUE (dataset_id, sequence_from, sequence_to, superseding_dataset_id)
);

CREATE INDEX IF NOT EXISTS history_corrections_dataset_idx
  ON trade.history_corrections (dataset_id, created_at ASC);

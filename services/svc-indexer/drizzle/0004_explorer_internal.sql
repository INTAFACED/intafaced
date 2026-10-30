-- D-explorer-03: the value contracts moved inside transactions ("internal transactions"), read from the node's own
-- trace of each block, and which blocks the node traced at all. A block the node would not trace is recorded with a
-- code, so the address page can say "trace unavailable" for exactly those blocks rather than show a short list.

-- One row per value move that stood: a call carrying value, a contract created with value, a self-destruct sending its
-- balance. `path` is the call's place in the trace tree ("0.2"). It belongs to its transaction and goes with it.
CREATE TABLE IF NOT EXISTS "indexer"."explorer_internal_txs" (
  "chain_id"      integer NOT NULL,
  "tx_hash"       text    NOT NULL,
  "path"          text    NOT NULL,
  "kind"          text    NOT NULL,
  "from_address"  text    NOT NULL,
  "to_address"    text    NOT NULL,
  "value_wei"     numeric(78, 0) NOT NULL,
  PRIMARY KEY ("chain_id", "tx_hash", "path"),
  CONSTRAINT "explorer_internal_txs_tx_fk" FOREIGN KEY ("chain_id", "tx_hash")
    REFERENCES "indexer"."explorer_txs" ("chain_id", "hash") ON DELETE CASCADE,
  CONSTRAINT "explorer_internal_txs_path_ck" CHECK ("path" ~ '^(0|[1-9][0-9]{0,5})(\.(0|[1-9][0-9]{0,5}))*$'),
  CONSTRAINT "explorer_internal_txs_kind_ck" CHECK ("kind" IN ('call', 'create', 'selfdestruct')),
  CONSTRAINT "explorer_internal_txs_from_ck" CHECK ("from_address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "explorer_internal_txs_to_ck" CHECK ("to_address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "explorer_internal_txs_value_ck" CHECK ("value_wei" > 0)
);

CREATE INDEX IF NOT EXISTS "explorer_internal_txs_from" ON "indexer"."explorer_internal_txs" ("chain_id", "from_address");
CREATE INDEX IF NOT EXISTS "explorer_internal_txs_to" ON "indexer"."explorer_internal_txs" ("chain_id", "to_address");

-- Whether the node traced the block. Every block holding transactions has a row: one indexed before traces were read
-- says so with `indexer.trace_not_recorded`.
CREATE TABLE IF NOT EXISTS "indexer"."explorer_block_traces" (
  "chain_id"    integer NOT NULL,
  "block_hash"  text    NOT NULL,
  "traced"      boolean NOT NULL,
  "reason"      text,
  PRIMARY KEY ("chain_id", "block_hash"),
  CONSTRAINT "explorer_block_traces_block_fk" FOREIGN KEY ("chain_id", "block_hash")
    REFERENCES "indexer"."blocks" ("chain_id", "hash") ON DELETE CASCADE,
  CONSTRAINT "explorer_block_traces_reason_ck" CHECK (("traced" AND "reason" IS NULL) OR (NOT "traced" AND "reason" ~ '^indexer\.[a-z_]+$'))
);

-- Every block already holding transactions was indexed before traces were read: it gets its row now, so the gaps the
-- address page names are read from this table alone, never by scanning every block.
INSERT INTO "indexer"."explorer_block_traces" ("chain_id", "block_hash", "traced", "reason")
-- The code is joined from two parts so a test's schema rename (which rewrites every `indexer.` prefix) leaves it whole.
SELECT DISTINCT "chain_id", "block_hash", FALSE, 'indexer' || '.trace_not_recorded'
FROM "indexer"."explorer_txs"
ON CONFLICT ("chain_id", "block_hash") DO NOTHING;

CREATE INDEX IF NOT EXISTS "explorer_block_traces_gaps" ON "indexer"."explorer_block_traces" ("chain_id") WHERE NOT "traced";

-- D-explorer-02: one row per transaction the block walk read, plus its logs.
-- Value and gas are wei / gas units as numeric integers, never floats.
-- Null means the node did not report the field. A zero value is a real zero.
-- Orphaned blocks keep their rows (blocks are marked orphaned, not deleted)
-- so a same-nonce replacement can still name the hash it replaced.
CREATE TABLE IF NOT EXISTS "indexer"."explorer_txs" (
  "chain_id"          integer NOT NULL,
  "hash"              text    NOT NULL,
  "block_hash"        text    NOT NULL,
  "tx_index"          integer NOT NULL,
  "from_address"      text    NOT NULL,
  "to_address"        text,
  "value_wei"         numeric(78, 0) NOT NULL,
  "nonce"             integer NOT NULL,
  "gas_limit"         numeric(78, 0) NOT NULL,
  "gas_price_wei"     numeric(78, 0),
  "gas_consumed"      numeric(78, 0),
  "receipt_status"    text    NOT NULL,
  "revert_reason"     text,
  "input_data"        text    NOT NULL,
  "created_contract"  text,
  PRIMARY KEY ("chain_id", "hash"),
  CONSTRAINT "explorer_txs_block_fk" FOREIGN KEY ("chain_id", "block_hash")
    REFERENCES "indexer"."blocks" ("chain_id", "hash") ON DELETE CASCADE,
  CONSTRAINT "explorer_txs_hash_ck" CHECK ("hash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "explorer_txs_from_ck" CHECK ("from_address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "explorer_txs_to_ck" CHECK ("to_address" IS NULL OR "to_address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "explorer_txs_created_ck" CHECK ("created_contract" IS NULL OR "created_contract" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "explorer_txs_status_ck" CHECK ("receipt_status" IN ('success', 'failed')),
  CONSTRAINT "explorer_txs_success_reason_ck" CHECK ("receipt_status" <> 'success' OR "revert_reason" IS NULL),
  CONSTRAINT "explorer_txs_nonneg_ck" CHECK ("tx_index" >= 0 AND "nonce" >= 0 AND "value_wei" >= 0 AND "gas_limit" >= 0),
  CONSTRAINT "explorer_txs_index_uq" UNIQUE ("chain_id", "block_hash", "tx_index")
);

CREATE INDEX IF NOT EXISTS "explorer_txs_sender_nonce"
  ON "indexer"."explorer_txs" ("chain_id", "from_address", "nonce");

CREATE TABLE IF NOT EXISTS "indexer"."explorer_tx_logs" (
  "chain_id"   integer NOT NULL,
  "tx_hash"    text    NOT NULL,
  "log_index"  integer NOT NULL,
  "address"    text    NOT NULL,
  "topics"     text    NOT NULL,
  "data"       text    NOT NULL,
  PRIMARY KEY ("chain_id", "tx_hash", "log_index"),
  CONSTRAINT "explorer_tx_logs_tx_fk" FOREIGN KEY ("chain_id", "tx_hash")
    REFERENCES "indexer"."explorer_txs" ("chain_id", "hash") ON DELETE CASCADE,
  CONSTRAINT "explorer_tx_logs_address_ck" CHECK ("address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "explorer_tx_logs_index_ck" CHECK ("log_index" >= 0)
);

-- A hash we saw in the mempool. First sight sticks. Not a block row: the
-- node may drop it before we ever index a block that contains it.
CREATE TABLE IF NOT EXISTS "indexer"."explorer_tx_seen" (
  "chain_id"      integer NOT NULL,
  "hash"          text    NOT NULL,
  "first_seen_at" timestamptz NOT NULL,
  PRIMARY KEY ("chain_id", "hash"),
  CONSTRAINT "explorer_tx_seen_hash_ck" CHECK ("hash" ~ '^0x[0-9a-f]{64}$')
);

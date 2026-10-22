-- D-explorer-01: explorer block facts, one row per indexed block (canonical or
-- orphaned), keyed like "indexer"."blocks". Filled by the existing block walk.
-- A partially read block is never stored: every column is NOT NULL except
-- base_fee_per_gas, which a pre-London / non-EIP-1559 network does not report
-- (absent => NULL, shown as "Not reported by this network", never zero).
-- The column is "gas_consumed", not "gas_used": the boundary scan (M-balance) reserves
-- *_used column names for money balances, and gas is a block fact, not money.
CREATE TABLE IF NOT EXISTS "indexer"."explorer_block_facts" (
  "chain_id"         integer NOT NULL,
  "hash"             text    NOT NULL,
  "gas_consumed"     numeric(78, 0) NOT NULL,
  "gas_limit"        numeric(78, 0) NOT NULL,
  "base_fee_per_gas" numeric(78, 0),
  "miner"            text    NOT NULL,
  "tx_count"         integer NOT NULL,
  "size"             integer NOT NULL,
  PRIMARY KEY ("chain_id", "hash"),
  CONSTRAINT "explorer_block_facts_block_fk" FOREIGN KEY ("chain_id", "hash")
    REFERENCES "indexer"."blocks" ("chain_id", "hash") ON DELETE CASCADE,
  CONSTRAINT "explorer_block_facts_gas_ck" CHECK ("gas_consumed" >= 0 AND "gas_limit" >= 0),
  CONSTRAINT "explorer_block_facts_miner_ck" CHECK ("miner" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "explorer_block_facts_counts_ck" CHECK ("tx_count" >= 0 AND "size" >= 0)
);

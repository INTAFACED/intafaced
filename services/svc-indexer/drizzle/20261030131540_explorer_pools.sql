-- D-explorer-05: pools, their swaps and their reserves, for the /dex/pools pages.
-- Like explorer_transfers, each row is copied out of its own stored log (no extra node read) and cascades with it,
-- so an orphaned block keeps its rows and a re-included hash replaces them. Which pools are listed is decided at read
-- time by the owner's factory address: any contract can emit these events, so nothing here is trusted on its own.

-- One row per PoolCreated(address indexed token0, address indexed token1, uint16 feeBps, address pool, uint256 index).
CREATE TABLE IF NOT EXISTS "indexer"."explorer_pools" (
  "chain_id"   integer NOT NULL,
  "tx_hash"    text    NOT NULL,
  "log_index"  integer NOT NULL,
  "factory"    text    NOT NULL,
  "pool"       text    NOT NULL,
  "token0"     text    NOT NULL,
  "token1"     text    NOT NULL,
  "fee_bps"    integer NOT NULL,
  PRIMARY KEY ("chain_id", "tx_hash", "log_index"),
  CONSTRAINT "explorer_pools_log_fk" FOREIGN KEY ("chain_id", "tx_hash", "log_index")
    REFERENCES "indexer"."explorer_tx_logs" ("chain_id", "tx_hash", "log_index") ON DELETE CASCADE,
  CONSTRAINT "explorer_pools_address_ck" CHECK (
    "factory" ~ '^0x[0-9a-f]{40}$' AND "pool" ~ '^0x[0-9a-f]{40}$' AND "token0" ~ '^0x[0-9a-f]{40}$' AND "token1" ~ '^0x[0-9a-f]{40}$'
  ),
  CONSTRAINT "explorer_pools_fee_ck" CHECK ("fee_bps" >= 0 AND "fee_bps" <= 65535)
);

CREATE INDEX IF NOT EXISTS "explorer_pools_factory" ON "indexer"."explorer_pools" ("chain_id", "factory");
CREATE INDEX IF NOT EXISTS "explorer_pools_pool" ON "indexer"."explorer_pools" ("chain_id", "pool");

-- One row per Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out,
-- address indexed to). Amounts are raw base units.
CREATE TABLE IF NOT EXISTS "indexer"."explorer_swaps" (
  "chain_id"     integer NOT NULL,
  "tx_hash"      text    NOT NULL,
  "log_index"    integer NOT NULL,
  "pool"         text    NOT NULL,
  "sender"       text    NOT NULL,
  "recipient"    text    NOT NULL,
  "amount0_in"   numeric(78, 0) NOT NULL,
  "amount1_in"   numeric(78, 0) NOT NULL,
  "amount0_out"  numeric(78, 0) NOT NULL,
  "amount1_out"  numeric(78, 0) NOT NULL,
  PRIMARY KEY ("chain_id", "tx_hash", "log_index"),
  CONSTRAINT "explorer_swaps_log_fk" FOREIGN KEY ("chain_id", "tx_hash", "log_index")
    REFERENCES "indexer"."explorer_tx_logs" ("chain_id", "tx_hash", "log_index") ON DELETE CASCADE,
  CONSTRAINT "explorer_swaps_address_ck" CHECK (
    "pool" ~ '^0x[0-9a-f]{40}$' AND "sender" ~ '^0x[0-9a-f]{40}$' AND "recipient" ~ '^0x[0-9a-f]{40}$'
  )
);

CREATE INDEX IF NOT EXISTS "explorer_swaps_pool" ON "indexer"."explorer_swaps" ("chain_id", "pool");

-- One row per Sync(uint112 reserve0, uint112 reserve1): the pool's reserves after that log.
CREATE TABLE IF NOT EXISTS "indexer"."explorer_syncs" (
  "chain_id"   integer NOT NULL,
  "tx_hash"    text    NOT NULL,
  "log_index"  integer NOT NULL,
  "pool"       text    NOT NULL,
  "reserve0"   numeric(78, 0) NOT NULL,
  "reserve1"   numeric(78, 0) NOT NULL,
  PRIMARY KEY ("chain_id", "tx_hash", "log_index"),
  CONSTRAINT "explorer_syncs_log_fk" FOREIGN KEY ("chain_id", "tx_hash", "log_index")
    REFERENCES "indexer"."explorer_tx_logs" ("chain_id", "tx_hash", "log_index") ON DELETE CASCADE,
  CONSTRAINT "explorer_syncs_pool_ck" CHECK ("pool" ~ '^0x[0-9a-f]{40}$')
);

CREATE INDEX IF NOT EXISTS "explorer_syncs_pool" ON "indexer"."explorer_syncs" ("chain_id", "pool");

-- Rows for logs already stored before this migration. A uint256 is read from 64 hex digits eight 32-bit words at a
-- time, as 0003 does (Postgres has no wider bit cast); word w of the data starts at character 3 + 64 * w.
CREATE OR REPLACE FUNCTION "indexer"."explorer_word_uint"(data text, w integer) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT sum(('x' || substr(data, 3 + w * 64 + p * 8, 8))::bit(32)::bigint::numeric * (4294967296::numeric ^ (7 - p)))
  FROM generate_series(0, 7) AS p
$$;

INSERT INTO "indexer"."explorer_pools" ("chain_id", "tx_hash", "log_index", "factory", "pool", "token0", "token1", "fee_bps")
SELECT l."chain_id", l."tx_hash", l."log_index", l."address",
       '0x' || lower(substr(l."data", 3 + 64 + 24, 40)),
       '0x' || substr(l."topics"::jsonb ->> 1, 27),
       '0x' || substr(l."topics"::jsonb ->> 2, 27),
       "indexer"."explorer_word_uint"(l."data", 0)::integer
FROM "indexer"."explorer_tx_logs" l
WHERE jsonb_array_length(l."topics"::jsonb) = 3
  AND l."topics"::jsonb ->> 0 = '0xa7fe820b1195583db141064eed24e76a61598a82b80a95d2915d14bb12758172'
  AND length(l."data") = 194 AND l."data" ~ '^0x[0-9a-fA-F]+$'
  AND substr(l."data", 3, 60) ~ '^0{60}$'
  AND substr(l."data", 3 + 64, 24) ~ '^0{24}$'
  AND l."topics"::jsonb ->> 1 ~ '^0x0{24}[0-9a-f]{40}$'
  AND l."topics"::jsonb ->> 2 ~ '^0x0{24}[0-9a-f]{40}$'
ON CONFLICT DO NOTHING;

INSERT INTO "indexer"."explorer_swaps" (
  "chain_id", "tx_hash", "log_index", "pool", "sender", "recipient", "amount0_in", "amount1_in", "amount0_out", "amount1_out"
)
SELECT l."chain_id", l."tx_hash", l."log_index", l."address",
       '0x' || substr(l."topics"::jsonb ->> 1, 27),
       '0x' || substr(l."topics"::jsonb ->> 2, 27),
       "indexer"."explorer_word_uint"(l."data", 0), "indexer"."explorer_word_uint"(l."data", 1),
       "indexer"."explorer_word_uint"(l."data", 2), "indexer"."explorer_word_uint"(l."data", 3)
FROM "indexer"."explorer_tx_logs" l
WHERE jsonb_array_length(l."topics"::jsonb) = 3
  AND l."topics"::jsonb ->> 0 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
  AND length(l."data") = 258 AND l."data" ~ '^0x[0-9a-fA-F]+$'
  AND l."topics"::jsonb ->> 1 ~ '^0x0{24}[0-9a-f]{40}$'
  AND l."topics"::jsonb ->> 2 ~ '^0x0{24}[0-9a-f]{40}$'
ON CONFLICT DO NOTHING;

INSERT INTO "indexer"."explorer_syncs" ("chain_id", "tx_hash", "log_index", "pool", "reserve0", "reserve1")
SELECT l."chain_id", l."tx_hash", l."log_index", l."address",
       "indexer"."explorer_word_uint"(l."data", 0), "indexer"."explorer_word_uint"(l."data", 1)
FROM "indexer"."explorer_tx_logs" l
WHERE jsonb_array_length(l."topics"::jsonb) = 1
  AND l."topics"::jsonb ->> 0 = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'
  AND length(l."data") = 130 AND l."data" ~ '^0x[0-9a-fA-F]+$'
ON CONFLICT DO NOTHING;

DROP FUNCTION "indexer"."explorer_word_uint"(text, integer);

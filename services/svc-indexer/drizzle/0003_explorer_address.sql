-- D-explorer-03: what an address page and a token search read.
-- An address's transactions are the ones it sent, the ones sent to it, and the
-- ones whose ERC-20 Transfer logs name it. Transfers are copied out of the
-- stored logs (no extra node read), so they follow their log: an orphaned
-- block keeps them, a re-included hash replaces them.
CREATE INDEX IF NOT EXISTS "explorer_txs_recipient"
  ON "indexer"."explorer_txs" ("chain_id", "to_address");

-- One row per ERC-20 Transfer(address indexed from, address indexed to, uint256 value) log.
-- A log with that topic but another shape (ERC-721 puts the id in a fourth topic) is not a transfer here.
CREATE TABLE IF NOT EXISTS "indexer"."explorer_transfers" (
  "chain_id"      integer NOT NULL,
  "tx_hash"       text    NOT NULL,
  "log_index"     integer NOT NULL,
  "token"         text    NOT NULL,
  "from_address"  text    NOT NULL,
  "to_address"    text    NOT NULL,
  "amount"        numeric(78, 0) NOT NULL,
  PRIMARY KEY ("chain_id", "tx_hash", "log_index"),
  CONSTRAINT "explorer_transfers_log_fk" FOREIGN KEY ("chain_id", "tx_hash", "log_index")
    REFERENCES "indexer"."explorer_tx_logs" ("chain_id", "tx_hash", "log_index") ON DELETE CASCADE,
  CONSTRAINT "explorer_transfers_token_ck" CHECK ("token" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "explorer_transfers_from_ck" CHECK ("from_address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "explorer_transfers_to_ck" CHECK ("to_address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "explorer_transfers_amount_ck" CHECK ("amount" >= 0)
);

CREATE INDEX IF NOT EXISTS "explorer_transfers_from" ON "indexer"."explorer_transfers" ("chain_id", "from_address");
CREATE INDEX IF NOT EXISTS "explorer_transfers_to" ON "indexer"."explorer_transfers" ("chain_id", "to_address");
CREATE INDEX IF NOT EXISTS "explorer_transfers_token" ON "indexer"."explorer_transfers" ("chain_id", "token");

-- Transfers already stored before this migration, from their logs.
INSERT INTO "indexer"."explorer_transfers" ("chain_id", "tx_hash", "log_index", "token", "from_address", "to_address", "amount")
SELECT l."chain_id", l."tx_hash", l."log_index", l."address",
       '0x' || substr(l."topics"::jsonb ->> 1, 27),
       '0x' || substr(l."topics"::jsonb ->> 2, 27),
       -- uint256 from 64 hex digits, eight 32-bit words at a time (Postgres has no wider bit cast).
       (SELECT sum(('x' || substr(l."data", 3 + w * 8, 8))::bit(32)::bigint::numeric * (4294967296::numeric ^ (7 - w)))
          FROM generate_series(0, 7) AS w)::numeric(78, 0)
FROM "indexer"."explorer_tx_logs" l
WHERE jsonb_array_length(l."topics"::jsonb) = 3
  AND l."topics"::jsonb ->> 0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  AND l."data" ~ '^0x[0-9a-fA-F]{64}$'
  AND l."topics"::jsonb ->> 1 ~ '^0x0{24}[0-9a-f]{40}$'
  AND l."topics"::jsonb ->> 2 ~ '^0x0{24}[0-9a-f]{40}$'
ON CONFLICT DO NOTHING;

-- What a token contract said about itself the first time the indexer saw it emit a Transfer.
-- Null is "the contract did not answer that call" (no such function, or a reverting one), never a guess.
CREATE TABLE IF NOT EXISTS "indexer"."explorer_tokens" (
  "chain_id"  integer NOT NULL,
  "address"   text    NOT NULL,
  "symbol"    text,
  "name"      text,
  "decimals"  integer,
  "read_at_height" bigint NOT NULL,
  PRIMARY KEY ("chain_id", "address"),
  CONSTRAINT "explorer_tokens_address_ck" CHECK ("address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "explorer_tokens_decimals_ck" CHECK ("decimals" IS NULL OR ("decimals" >= 0 AND "decimals" <= 255))
);

CREATE INDEX IF NOT EXISTS "explorer_tokens_symbol" ON "indexer"."explorer_tokens" ("chain_id", lower("symbol"));

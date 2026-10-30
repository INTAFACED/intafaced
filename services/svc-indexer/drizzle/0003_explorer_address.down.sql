-- intafaced:destructive — reversal of 0003_explorer_address.sql
DROP TABLE IF EXISTS "indexer"."explorer_tokens";
DROP TABLE IF EXISTS "indexer"."explorer_transfers";
DROP INDEX IF EXISTS "indexer"."explorer_txs_recipient";

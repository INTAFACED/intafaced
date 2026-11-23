-- intafaced:destructive — reversal of 0000_ledger_init.sql
--
-- This drops the entire balance graph. It exists so the migration is provably
-- reversible in CI against a scratch schema (§14). It must NEVER be run against
-- a database that has posted real transactions: the ledger is the record, and
-- the record is not recoverable from anywhere else.

DROP TABLE IF EXISTS "ledger"."balance_snapshots";
DROP TABLE IF EXISTS "ledger"."ledger_entries";
DROP TABLE IF EXISTS "ledger"."ledger_tx";
DROP TABLE IF EXISTS "ledger"."chain_tip";
DROP TABLE IF EXISTS "ledger"."accounts";
DROP TABLE IF EXISTS "ledger"."assets";

DROP TYPE IF EXISTS "ledger"."direction";
DROP TYPE IF EXISTS "ledger"."asset_kind";
DROP TYPE IF EXISTS "ledger"."account_kind";
DROP TYPE IF EXISTS "ledger"."owner_type";

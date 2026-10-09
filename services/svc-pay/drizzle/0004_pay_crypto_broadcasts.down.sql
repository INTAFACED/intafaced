-- intafaced:destructive — reversal of 0004_pay_crypto_broadcasts.sql
--
-- This drops the signed raw transaction journal in `signed_raw`.
--
-- It exists so the migration is provably reversible in CI against a scratch
-- schema (§14). It must NEVER run against live rows because what the table
-- maps is not recoverable from the ledger. The table maps the signed raw
-- transaction journal in `signed_raw`.

DROP INDEX IF EXISTS "pay"."crypto_broadcasts_updated_idx";
DROP TABLE IF EXISTS "pay"."crypto_broadcasts";

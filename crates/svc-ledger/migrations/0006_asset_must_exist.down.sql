-- Reverses 0006_asset_must_exist.sql
--
-- Dropping these keys restores the old behaviour exactly: `asset_id` goes back
-- to being `text` that accepts anything, and a typo can once again open a
-- second conformant book that balances, reconciles and hash-chains while being
-- unreachable by any rail. Reversible does not mean harmless — this is the
-- door, re-opened.
--
-- STEP 1 of the forward migration raises rather than writing, so it has nothing
-- to reverse: no row was changed, moved or deleted in either direction. The
-- index goes with the constraint it was added to serve.

ALTER TABLE "ledger"."ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_asset_id_fk";
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_asset_id_fk";

DROP INDEX IF EXISTS "ledger"."accounts_asset_id_idx";

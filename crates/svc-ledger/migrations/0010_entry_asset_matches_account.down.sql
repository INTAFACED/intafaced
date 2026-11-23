-- Reversal of 0010_entry_asset_matches_account.sql
--
-- STEP 1 raised rather than writing, so it has nothing to reverse: no entry and no
-- account was rewritten on the way in, which is the practical argument for refusing
-- over repairing — a migration that guesses which asset moved has no honest reversal.
--
-- Order matters: the foreign key references the unique constraint, so the constraint
-- cannot be dropped while the key still points at it.
--
-- Going back only widens what the table accepts, back to 0006's position: each column
-- individually valid, the pair unconstrained. No data is at risk in this direction —
-- only the invariant, which `postgres-ledger.ts` still upholds on the TypeScript path
-- by writing `entry.account.assetId` into both columns.
ALTER TABLE "ledger"."ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_account_asset_fk";
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_id_asset_uq";

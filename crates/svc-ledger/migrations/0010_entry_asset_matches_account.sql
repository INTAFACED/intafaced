-- svc-ledger · an entry's asset must be its account's asset
-- Reversal: 0010_entry_asset_matches_account.down.sql
--
-- THE DEFECT
--
-- `ledger_entries` carries its own `asset_id`, and nothing tied it to the asset of
-- the account the entry posts against. Both columns had a foreign key to `assets`
-- (0006), so each was individually valid — and raw SQL could still record a `USDT`
-- entry against a `BTC` account.
--
-- What that produces is the worst shape this schema has: the entry lands in one
-- asset's book while `balance_after` describes a balance in another. Every existing
-- guard passes. The entry is positive (`ledger_entries_positive_ck`), both assets
-- are registered (0006), the account is real, the transaction sums to zero per asset
-- as far as the entries themselves claim — and the account's actual running
-- `balance` was moved by an amount recorded against a different asset. Reconciliation
-- replays entries per asset, so it re-derives the same wrong answer and reports green.
--
-- Found while writing the ON DELETE RESTRICT test in #1068, which needed exactly this
-- divergence in order to isolate one foreign key from another. A test needing an
-- illegal state to be constructible is a finding about the schema, not about the test.
--
-- Reachable the same way #1044, #1050 and #1067 were: `postgres-ledger.ts` writes
-- `entry.account.assetId` into both columns and cannot produce a mismatch, and it is
-- not the only insert path the README says will exist. This is the last member of
-- that family in this service.

-- STEP 1 · REFUSE — every row here describes a movement in one asset against a
-- balance in another, and there is no honest repair.
--
-- Changing the entry's asset rewrites what the journal says happened; changing the
-- account's asset rewrites what a user holds; deleting the row destroys a posted
-- movement. All three are a human's call on real value, and the hash chain covers
-- the transaction either way. So this names the rows and stops — 0005 STEP 3, 0006
-- STEP 1, 0008 STEP 1, 0009 STEP 1.
--
-- Zero rows expected: no code path can produce one.
DO $$
DECLARE
  offenders text;
  n bigint;
BEGIN
  SELECT count(*), string_agg(format('entry %s tx=%s account=%s entry_asset=%s account_asset=%s amount=%s', e."id", e."tx_id", e."account_id", e."asset_id", a."asset_id", e."amount"), E'\n  ')
    INTO n, offenders
    FROM "ledger"."ledger_entries" e
    JOIN "ledger"."accounts" a ON a."id" = e."account_id"
   WHERE e."asset_id" <> a."asset_id";

  IF n > 0 THEN
    RAISE EXCEPTION
      E'Cannot apply 0010: % ledger entr(ies) record a movement in one asset against an account holding '
      'another.\n  %\n\n'
      'The entry is in the first asset''s book while balance_after describes a balance in the second, and '
      'every existing guard passes on it — the amount is positive, both assets are registered, the account '
      'exists, and reconciliation replays per asset so it re-derives the same wrong answer and reports green.\n\n'
      'There is no automatic repair: changing the entry''s asset rewrites what the journal says happened, '
      'changing the account''s asset rewrites what a user holds, and deleting the row destroys a posted '
      'movement. A human must decide per row which asset was actually moved. Precedent: 0005 STEP 3, '
      '0006 STEP 1, 0008 STEP 1, 0009 STEP 1.',
      n, offenders;
  END IF;
END $$;

-- STEP 2 · The foreign key target.
--
-- `accounts.id` is already the primary key, so (id, asset_id) is trivially unique —
-- but Postgres requires a declared unique constraint on the exact column list a
-- composite foreign key references, so it has to be stated. It adds no invariant
-- the primary key did not already imply; it only makes the pair referenceable.
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_id_asset_uq";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_id_asset_uq" UNIQUE ("id", "asset_id");

-- STEP 3 · The rule.
--
-- Additive: `ledger_entries_account_id_fkey` and `ledger_entries_asset_id_fk` both
-- stay. Dropping either to "simplify" would revalidate the whole journal table under
-- a lock for no gain, and each still says something on its own — this one says the
-- two must agree.
--
-- RESTRICT on both actions, matching 0006: an account cannot be re-pointed at another
-- asset while entries describe it, and cannot be deleted out from under them.
ALTER TABLE "ledger"."ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_account_asset_fk";
ALTER TABLE "ledger"."ledger_entries"
  ADD CONSTRAINT "ledger_entries_account_asset_fk"
  FOREIGN KEY ("account_id", "asset_id")
  REFERENCES "ledger"."accounts" ("id", "asset_id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

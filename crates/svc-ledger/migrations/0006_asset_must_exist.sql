-- svc-ledger · an account may only exist in an asset the ledger knows (§4.2)
-- Reversal: 0006_asset_must_exist.down.sql
--
-- THE DEFECT
--
-- Three separate places in this codebase state that value cannot exist in an
-- unregistered asset:
--
--   0003_commodity_asset_kind.sql — "Every one of them needs a row in
--     `ledger.assets` before a balance in it can exist."
--   0004_multi_asset_seed.sql — "a market whose asset has no row here fails at
--     the first ledger post rather than at listing time."
--   packages/contracts/src/instruments.test.ts — "the app boots with a market
--     whose asset does not exist and the first order fails at the ledger rather
--     than at the listing."
--
-- None of it was true. `accounts.asset_id` and `ledger_entries.asset_id` were
-- bare `text` with no foreign key, no CHECK and no lookup, and no code under
-- `services/svc-ledger/src/` read the `assets` table at all — it was declared
-- in `schema.ts` and consulted by nothing.
--
-- So a one-character typo opened a second, fully conformant book. `USTD` and
-- `USDT` both balance per-asset, both stay non-negative, both hash-chain, and
-- `reconcile()` and `verifyChain()` both return ok. The value is real, and it
-- is unreachable: no rail, no market and no asset-keyed query will ever see it,
-- and nothing in the book tells you it is there.
--
-- This is structurally the same hole 0005 closed on the OWNER axis — an
-- identifier the ledger accepts but cannot resolve — left open on the ASSET
-- axis.
--
-- WHY A FOREIGN KEY AND NOT AN APPLICATION CHECK
--
-- The same argument 0005 and the README make for `owner_id`: "an adapter
-- bridging a Java stack is the least likely caller in the OS to route through a
-- TypeScript library, so application-only enforcement would be bypassable by
-- exactly the thing it exists to stop." A CHECK cannot reference another table,
-- so the foreign key is the only form this invariant can take in the database.
--
-- `ON DELETE RESTRICT` is deliberate: retiring an asset that still holds
-- balances must fail loudly. `active = false` is how an asset is withdrawn from
-- new business, and it is a data change, not a deletion.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 · REFUSE — anything holding value in an asset we cannot name.
--
-- There is no honest automatic repair. Seeding the missing asset would bless a
-- typo and make the phantom book permanent; deleting the rows would destroy
-- value. Both are decisions for a human with the context, so this fails at
-- migrate time on the populated database where the problem actually is, naming
-- every offending asset — rather than succeeding on an empty one and taking the
-- service down on deploy.
DO $$
DECLARE
  orphans text;
BEGIN
  SELECT string_agg(DISTINCT missing, ', ' ORDER BY missing) INTO orphans
    FROM (
      SELECT a."asset_id" AS missing
        FROM "ledger"."accounts" a
       WHERE NOT EXISTS (SELECT 1 FROM "ledger"."assets" s WHERE s."id" = a."asset_id")
       UNION
      SELECT e."asset_id"
        FROM "ledger"."ledger_entries" e
       WHERE NOT EXISTS (SELECT 1 FROM "ledger"."assets" s WHERE s."id" = e."asset_id")
    ) AS q;

  IF orphans IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot apply 0006: the ledger holds rows in asset(s) that have no row in ledger.assets: %. '
      'Each one is either a real asset that was never seeded — add it to a seed migration and re-run — '
      'or a typo that opened a phantom book, in which case moving the value out is a ledger post '
      'through ledger-client (Doctrine 0.6), never an UPDATE in a migration.', orphans;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 · The constraint the comments have been claiming all along.
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_asset_id_fk";
ALTER TABLE "ledger"."accounts"
  ADD CONSTRAINT "accounts_asset_id_fk"
  FOREIGN KEY ("asset_id") REFERENCES "ledger"."assets" ("id") ON DELETE RESTRICT;

-- `ledger_entries.asset_id` is denormalised from the account it points at, so
-- the key above already covers every entry written through an account row. It
-- is constrained anyway: the column is written independently, and an entry that
-- disagrees with its own account is exactly the drift the reconciliation job
-- exists to catch — cheaper to make impossible.
ALTER TABLE "ledger"."ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_asset_id_fk";
ALTER TABLE "ledger"."ledger_entries"
  ADD CONSTRAINT "ledger_entries_asset_id_fk"
  FOREIGN KEY ("asset_id") REFERENCES "ledger"."assets" ("id") ON DELETE RESTRICT;

-- ONE index, on `accounts` only, and not for the foreign key.
--
-- The key's own check reads `assets.id`, which is already the primary key —
-- neither of these indexes would serve it. What this one serves is the
-- reconciliation job's `SELECT asset_id, SUM(balance) ... GROUP BY asset_id`
-- (src/ledger/reconcile.ts), which runs on a schedule, plus the RESTRICT check
-- when someone tries to delete an asset.
--
-- `ledger_entries` deliberately gets NO such index. Nothing queries entries by
-- asset, the only reader would be that same RESTRICT check on an admin
-- operation that is refused anyway and essentially never runs, and every insert
-- on the globally-serial posting path would pay to maintain it against a table
-- with ninety days of retention. A seq scan on a delete nobody performs is the
-- cheaper side of that trade.
CREATE INDEX IF NOT EXISTS "accounts_asset_id_idx" ON "ledger"."accounts" ("asset_id");

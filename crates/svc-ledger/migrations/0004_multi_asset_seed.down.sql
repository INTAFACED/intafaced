-- Reversal of 0004_multi_asset_seed.sql
--
-- Removes the seeded commodity and forex assets — but ONLY if nothing is
-- denominated in them. An asset row is not decoration: `ledger.accounts.asset_id`
-- points at it, and every entry in the journal is denominated by it. Deleting
-- one out from under a live account would leave balances referring to an asset
-- the ledger no longer defines, and the ledger is the one place in the OS where
-- "we can reconstruct it later" is false by design.
--
-- So this refuses rather than cascades, in the same spirit as 0002's reversal.
-- An operator who genuinely means to delist an asset does that deliberately,
-- with the balances migrated first — not as a side effect of a schema rollback.
DO $$
DECLARE
  in_use text;
BEGIN
  SELECT string_agg(DISTINCT "asset_id", ', ') INTO in_use
    FROM "ledger"."accounts"
   WHERE "asset_id" IN ('JPY', 'CHF', 'CAD', 'AUD', 'XAU', 'XAG', 'WTI', 'BRENT', 'NATGAS');

  IF in_use IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot reverse 0004: accounts still exist for %. Those balances are real and belong to somebody; '
      'deleting the asset definition would orphan them. Migrate or close the accounts first.',
      in_use;
  END IF;
END $$;

DELETE FROM "ledger"."assets"
 WHERE "id" IN ('JPY', 'CHF', 'CAD', 'AUD', 'XAU', 'XAG', 'WTI', 'BRENT', 'NATGAS');

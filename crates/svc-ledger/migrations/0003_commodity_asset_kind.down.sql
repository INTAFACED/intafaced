-- Reversal of 0003_commodity_asset_kind.sql
--
-- Postgres cannot remove a value from an enum. Reversing this properly means
-- rebuilding the type and rewriting every column that uses it, which on
-- `ledger.assets` is a rewrite of the table every balance in the system is keyed
-- on — to delete a value that costs nothing to leave in place.
--
-- So this reversal asserts the safe condition instead: no asset may still be
-- USING the kind. That is the part that actually matters, because 0004's
-- reversal removes those rows; if one survived, some account somewhere is
-- denominated in an asset this rollback is about to orphan.
--
-- The unused enum label stays. It is inert, and an inert label is a far smaller
-- problem than a table rewrite performed by a rollback.
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining FROM "ledger"."assets" WHERE "kind" = 'commodity';

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'Cannot reverse 0003: % asset(s) are still of kind ''commodity''. Reverse 0004 first — '
      'dropping the kind out from under a live asset would orphan every balance denominated in it.',
      remaining;
  END IF;
END $$;

-- Reversal of 0014_purpose_trim_matches_string_trim.sql.
-- Restores the shorter pad list 0012 installed before this widening:
-- space, tab, LF, CR, VT, FF, NBSP. Row data was refused, not rewritten.

ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_lock_purposed_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_lock_purposed_ck"
  CHECK (
    ("kind" = 'available' AND "purpose" = '')
    OR (
      "kind" <> 'available'
      AND "purpose" = btrim("purpose", E' \t\n\r\v\f' || chr(160))
      AND length("purpose") > 0
      AND "purpose" NOT LIKE 'legacy:%'
    )
  );

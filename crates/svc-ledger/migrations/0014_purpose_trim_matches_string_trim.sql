-- intafaced:destructive — 0012 already shipped a shorter pad list. Databases that
-- applied that file will not re-read it. This re-states the same check so a
-- raw insert cannot open a second pot with a pad String.trim strips.
-- Reversal: 0014_purpose_trim_matches_string_trim.down.sql
--
-- Pad set is exactly what JavaScript String.prototype.trim strips. U+180E is
-- not in that set. This migration will not rewrite claim keys.

DO $$
DECLARE
  offenders text;
  n bigint;
  pads text := E' \t\n\r\f' || chr(11) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279);
BEGIN
  SELECT count(*), string_agg(
    format('%s/%s %s %s purpose=%L balance=%s', "owner_type", "owner_id", "asset_id", "kind", "purpose", "balance"),
    E'\n  '
  )
    INTO n, offenders
    FROM "ledger"."accounts"
   WHERE "purpose" <> btrim("purpose", pads)
      OR ("kind" = 'available' AND length(btrim("purpose", pads)) > 0)
      OR ("kind" <> 'available' AND length(btrim("purpose", pads)) = 0)
      OR ("kind" <> 'available' AND btrim("purpose", pads) LIKE 'legacy:%');

  IF n > 0 THEN
    RAISE EXCEPTION
      E'Cannot apply 0014: % account row(s) violate purpose identity law (JS-trim pads / available empty / no legacy:).\n  %\n\n'
      'Client identity uses String.trim(); DB must refuse the same dual-book pads, including U+FEFF, U+2028, and U+2029. '
      'This migration will not rewrite claim keys. For each row: set purpose to the trimmed claim that '
      'reserved the pot (or empty for available), move any dual-book balance under a human decision, then re-run.',
      n, offenders;
  END IF;
END $$;

ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_lock_purposed_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_lock_purposed_ck"
  CHECK (
    ("kind" = 'available' AND "purpose" = '')
    OR (
      "kind" <> 'available'
      AND "purpose" = btrim("purpose", E' \t\n\r\f' || chr(11) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279))
      AND length("purpose") > 0
      AND "purpose" NOT LIKE 'legacy:%'
    )
  );

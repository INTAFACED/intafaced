-- intafaced:destructive drops accounts_lock_purposed_ck, replaced in the same
-- migration by a form that mirrors client purpose identity law.
-- svc-ledger · purpose trim + available empty (DB belt for #1481/#1517 client)
-- Reversal: 0011_purpose_trim_and_available.down.sql
--
-- THE DEFECT
--
-- TypeScript identity trims purpose (`accountPurpose`) and refuses a purpose on
-- `available` (`assertAvailableUnpurposed`). The database CHECK from 0008 was:
--
--   kind = 'available' OR (length(purpose) > 0 AND purpose NOT LIKE 'legacy:%')
--
-- That admits three dual-book shapes via raw SQL (or any path that bypasses
-- ledger-client constructors):
--
--   · purpose '   ' — length 3, names nothing, survives as a lock pot
--   · purpose 'order:x ' — second pot next to the trimmed claim (P0-3)
--   · available purpose 'split' — second fungible pot; recon can stay green
--
-- Client seals post time. The belt must seal the book.
--
-- STEP 1 · REFUSE — every row here would create (or already is) a pot the
-- client would never open. No honest automatic repair: collapsing padded
-- purposes that both hold balance is a human call on real value. Precedent:
-- 0005 STEP 3, 0006 STEP 1, 0008 STEP 1, 0009 STEP 1, 0010 STEP 1.
--
-- Zero rows expected on tip: only ledger-client writes accounts, and it trims.

DO $$
DECLARE
  offenders text;
  n bigint;
BEGIN
  SELECT count(*), string_agg(
    format('%s/%s %s %s purpose=%L balance=%s', "owner_type", "owner_id", "asset_id", "kind", "purpose", "balance"),
    E'\n  '
  )
    INTO n, offenders
    FROM "ledger"."accounts"
   WHERE "purpose" <> btrim("purpose")
      OR ("kind" = 'available' AND length(btrim("purpose")) > 0)
      OR ("kind" <> 'available' AND length(btrim("purpose")) = 0)
      OR ("kind" <> 'available' AND btrim("purpose") LIKE 'legacy:%');

  IF n > 0 THEN
    RAISE EXCEPTION
      E'Cannot apply 0011: % account row(s) violate purpose identity law (trim / available empty / no legacy:).\n  %\n\n'
      'Client identity uses btrim(purpose); available must stay unpurposed; lock pots must name a real claim. '
      'This migration will not rewrite claim keys. For each row: set purpose to the trimmed claim that '
      'reserved the pot (or empty for available), move any dual-book balance under a human decision, then re-run.',
      n, offenders;
  END IF;
END $$;

-- STEP 2 · Re-state the invariant so raw SQL cannot re-open dual pots.
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_lock_purposed_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_lock_purposed_ck"
  CHECK (
    ("kind" = 'available' AND "purpose" = '')
    OR (
      "kind" <> 'available'
      AND "purpose" = btrim("purpose")
      AND length("purpose") > 0
      AND "purpose" NOT LIKE 'legacy:%'
    )
  );

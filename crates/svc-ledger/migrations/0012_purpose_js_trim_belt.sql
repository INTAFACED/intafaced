-- intafaced:destructive drops accounts_lock_purposed_ck, replaced in the same
-- migration by a form that mirrors client purpose identity law (JS String.trim).
-- svc-ledger · purpose pad belt covers tab / CR / LF / NBSP (0011 was space-only)
-- Reversal: 0012_purpose_js_trim_belt.down.sql
--
-- THE DEFECT
--
-- 0011 sealed purpose identity as `purpose = btrim(purpose)`. Postgres `btrim`
-- without a second argument strips only U+0020 SPACE. Client identity uses
-- JavaScript `String.prototype.trim()`, which also strips TAB, LF, CR, VT, FF,
-- NBSP, and other Unicode white space.
--
-- Raw SQL (or any path that bypasses ledger-client constructors) can therefore
-- open a second pot beside the trimmed claim:
--
--   · purpose 'order:x\t' next to 'order:x'  — P0-3 dual book, recon green
--   · purpose '\t\t\t'                         — lock pot that names nothing
--   · purpose 'order:x' + U+00A0               — same dual-book class
--
-- Client seals post time. The belt must seal the book for the same pad set.
--
-- Practical pad set (not every Unicode White_Space code point): space, tab,
-- LF, CR, VT, FF, NBSP. Those are the dual-book pads adapters invent. Client
-- .trim() may strip more; that is fine — client remains the stricter door.
--
-- STEP 1 · REFUSE — no honest automatic repair when two pots both hold value.
-- Precedent: 0005 / 0006 / 0008 / 0009 / 0010 / 0011 STEP 1.

DO $$
DECLARE
  offenders text;
  n bigint;
  pads text := E' \t\n\r\v\f' || chr(160);
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
      E'Cannot apply 0012: % account row(s) violate purpose identity law (JS-trim pads / available empty / no legacy:).\n  %\n\n'
      'Client identity uses String.trim(); DB must refuse the same dual-book pads (space/tab/CR/LF/NBSP). '
      'This migration will not rewrite claim keys. For each row: set purpose to the trimmed claim that '
      'reserved the pot (or empty for available), move any dual-book balance under a human decision, then re-run.',
      n, offenders;
  END IF;
END $$;

-- STEP 2 · Re-state the invariant so raw SQL cannot re-open dual pots via tab/NBSP.
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

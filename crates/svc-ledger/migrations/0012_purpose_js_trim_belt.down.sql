-- Reversal of 0012_purpose_js_trim_belt.sql — restores 0011's space-only btrim form.
--
-- 0012 STEP 1 refused rather than rewritten, so there is nothing to reverse
-- in row data. Only the constraint shape rolls back.

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

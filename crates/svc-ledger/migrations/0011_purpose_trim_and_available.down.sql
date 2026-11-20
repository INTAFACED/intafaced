-- Reversal of 0011_purpose_trim_and_available.sql — restores 0008's CHECK form.
--
-- 0011 STEP 1 refused rather than rewritten, so there is nothing to reverse
-- in row data. Only the constraint shape rolls back.

ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_lock_purposed_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_lock_purposed_ck"
  CHECK (
    "kind" = 'available'
    OR (length("purpose") > 0 AND "purpose" NOT LIKE 'legacy:%')
  );

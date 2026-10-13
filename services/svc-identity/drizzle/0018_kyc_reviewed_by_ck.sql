-- kyc_reviewed_by_ck was commented as "a reviewed record names its reviewer"
-- and then checked (status = 'pending' OR reviewed_at IS NOT NULL). reviewed_by
-- stayed nullable, so a new non-pending row could set reviewed_at and leave
-- the reviewer null or blank. Who granted the tier was not on the row.
--
-- A pending row may still omit the reviewer. Any other status needs reviewed_at
-- and a reviewed_by that is not null or whitespace. NOT VALID skips the
-- backlog: do not scan those rows into a failure, do not rewrite them, and do
-- not invent a reviewer name.

ALTER TABLE "identity"."kyc_records" DROP CONSTRAINT IF EXISTS "kyc_reviewed_by_ck";
ALTER TABLE "identity"."kyc_records" ADD CONSTRAINT "kyc_reviewed_by_ck"
  CHECK (
    ("reviewed_by" IS NULL OR "reviewed_by" !~ '^[[:space:]]*$')
    AND (
      "status" = 'pending'
      OR (
        "reviewed_at" IS NOT NULL
        AND "reviewed_by" IS NOT NULL
      )
    )
  ) NOT VALID;

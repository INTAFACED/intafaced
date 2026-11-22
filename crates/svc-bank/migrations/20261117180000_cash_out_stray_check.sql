-- The re-drive sweep for a partner-held cash-out refused while it was being driven (#8697). A driver that lost its lock
-- may have made the order move under `bank.cash-out:<id>` after another driver recorded the refusal, and crashed before
-- giving it back. The sweep used to read only requests created in the last day, newest first, and re-asked the partner
-- about every unmoved one on each pass: a stranded give-back could be crowded out, missed after a day's outage, or missed
-- on a request older than a day.
--
-- `drive_refused_at` is when a drive recorded the refusal (null for a request refused when it was asked, which no driver
-- ever moved). `stray_checked_at` is when the sweep last found no move under the order key. The sweep reads requests
-- never checked, or last checked before their refusal was a day old and not in the last hour, least recently checked
-- first; once a check lands a day after the refusal (a stray move is made within one drive's span) the row is settled
-- and never read again. No time window on the request's age.
--
-- Existing drive-refused partner-held rows cannot be told apart from ask-time refusals, so each is checked once more:
-- `drive_refused_at` is set to its creation time.
--
-- Reversal: 20261117180000_cash_out_stray_check.down.sql

ALTER TABLE "bank"."cash_out_requests"
  ADD COLUMN IF NOT EXISTS "drive_refused_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "stray_checked_at" timestamptz;

UPDATE "bank"."cash_out_requests" SET "drive_refused_at" = "created_at"
 WHERE "status" = 'refused' AND "custodian" IS NOT NULL AND "partner_back_move_id" IS NULL
   AND "refusal_code" = 'bank.cash_out_over_available' AND "drive_refused_at" IS NULL;

ALTER TABLE "bank"."cash_out_requests" DROP CONSTRAINT IF EXISTS "cash_out_requests_stray_check_ck";
ALTER TABLE "bank"."cash_out_requests" ADD CONSTRAINT "cash_out_requests_stray_check_ck" CHECK (
  ("drive_refused_at" IS NULL AND "stray_checked_at" IS NULL)
  OR ("status" = 'refused' AND "drive_refused_at" IS NOT NULL)
);

-- The sweep's read: unsettled drive-refused partner-held requests, least recently checked first.
CREATE INDEX IF NOT EXISTS "cash_out_requests_stray_sweep_idx"
  ON "bank"."cash_out_requests" ((coalesce("stray_checked_at", "drive_refused_at")))
  WHERE "status" = 'refused' AND "custodian" IS NOT NULL AND "partner_back_move_id" IS NULL
    AND "drive_refused_at" IS NOT NULL;

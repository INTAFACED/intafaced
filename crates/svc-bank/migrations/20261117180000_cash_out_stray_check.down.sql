-- Reversal of the re-drive sweep's check stamps (#8697). Safe at any time: the columns only steer which refused rows the
-- sweep re-asks the partner about; no money is recorded in them.
DROP INDEX IF EXISTS "bank"."cash_out_requests_stray_sweep_idx";
ALTER TABLE "bank"."cash_out_requests"
  DROP CONSTRAINT IF EXISTS "cash_out_requests_stray_check_ck",
  DROP COLUMN IF EXISTS "stray_checked_at",
  DROP COLUMN IF EXISTS "drive_refused_at";

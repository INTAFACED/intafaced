-- J-merchant-02 #5: a newly verified payout destination waits out the hold.
-- Reversal: see the .down.sql beside this file.
--
-- A destination saved by the owner is unverified (verified = false) and is
-- never paid. Verifying it with a fresh step-up sets verified, verified_at and
-- activates_at = verified_at + PAY_DESTINATION_HOLD_SECONDS. Until activates_at
-- the row is held and a payout to it is refused (pay.payout_destination_held).
-- NULL means there is no hold to wait out: every row written before this
-- migration, and a pending change once promoted. The hold length is not stored
-- here; blank config refuses the verification.

ALTER TABLE "pay"."merchant_payout_destinations"
  ADD COLUMN IF NOT EXISTS "activates_at" timestamptz;

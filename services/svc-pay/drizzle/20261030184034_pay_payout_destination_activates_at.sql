-- J-merchant-02 #5: a newly verified payout destination waits out the hold.
-- Reversal: see the .down.sql beside this file.
--
-- A destination saved by the owner is unverified (verified = false,
-- activates_at NULL) and is never paid. Verifying it with a fresh step-up sets
-- verified_at and activates_at = verified_at + PAY_DESTINATION_HOLD_SECONDS but
-- leaves verified = false: the row is held, and any code that reads only
-- `verified` (an older build after a rollback) still refuses to pay it. Once
-- activates_at has passed, svc-pay sets verified = true under the row lock on
-- the next read. Rows written before this migration keep activates_at NULL.
-- The hold length is not stored here; blank config refuses the verification.

ALTER TABLE "pay"."merchant_payout_destinations"
  ADD COLUMN IF NOT EXISTS "activates_at" timestamptz;

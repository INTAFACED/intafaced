-- L1249: yield_payouts.user_id must match stakes.user_id.
--
-- 0003 declared the payout user id uuid. stakes.user_id and
-- governance_votes.user_id are text. A staker id that is not a uuid cannot
-- be frozen into the payout plan, so that staker is not paid for the window.
--
-- This changes only the payout column. It does not rewrite stakes.user_id
-- or governance_votes.user_id, and it writes no amount and no rate.
-- Existing uuid values stay the same text the column already stored.

ALTER TABLE "token"."yield_payouts"
  ALTER COLUMN "user_id" TYPE text USING "user_id"::text;

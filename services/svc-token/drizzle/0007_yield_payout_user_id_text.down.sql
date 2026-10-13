-- Reverse of 0007.
--
-- A payout user id that is not a uuid cannot be cast back to uuid. This
-- refuses rather than dropping the plan. stakes.user_id and
-- governance_votes.user_id are not touched.

ALTER TABLE "token"."yield_payouts"
  ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;

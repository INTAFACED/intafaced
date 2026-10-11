-- L357: quorum uses the eligible stake snapshotted with the ballot.
--
-- `castVote` already stored the voter's weight. `closeProposal` re-summed
-- live `tokenStakeAccount` pots. Unstaking after a vote shrunk that
-- denominator under a weight the ballot kept. Staking after the window
-- raised it against votes already cast. Either side could force the result.
--
-- `eligible_stake` is the electorate total from the same read as `weight`.
-- Close takes the greatest of those figures. It does not re-sum live pots.
--
-- NULL stays for ballots cast before this column. Close refuses a NULL.
-- Treating it as zero would make the quorum comparison vacuously true.
-- No magnitude is written here.

ALTER TABLE "token"."governance_votes" ADD COLUMN IF NOT EXISTS "eligible_stake" numeric(38, 18);

ALTER TABLE "token"."governance_votes" DROP CONSTRAINT IF EXISTS "governance_votes_eligible_stake_ck";
ALTER TABLE "token"."governance_votes" ADD CONSTRAINT "governance_votes_eligible_stake_ck"
  CHECK (
    "eligible_stake" IS NULL
    OR ("eligible_stake" >= 0 AND "eligible_stake" >= "weight")
  );

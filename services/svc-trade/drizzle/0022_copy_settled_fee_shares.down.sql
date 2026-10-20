-- intafaced:destructive — drops trade.copy_settled_fee_shares, the per-follower fill claim taken before a fee share is posted.
-- Reversal of 0022_copy_settled_fee_shares.sql
--
-- Each row is the claim that stops a redelivered settleFeeShare from reserving a leader's earnings a second
-- time. The guard below refuses to roll back while any row exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "trade"."copy_settled_fee_shares") THEN
    RAISE EXCEPTION 'trade.copy_settled_fee_shares has rows; they are the claims that stop a fee share being reserved twice, so rolling back would allow a replay to reserve it again';
  END IF;
END
$$;

DROP TABLE IF EXISTS "trade"."copy_settled_fee_shares";

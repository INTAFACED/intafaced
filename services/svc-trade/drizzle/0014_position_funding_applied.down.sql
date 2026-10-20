-- intafaced:destructive — drops trade.position_funding_applied, the (position_id, period_id) key that lets a
-- funding period move a position's margin exactly once, and the per-position record of which periods were paid.
-- Reverses 0014_position_funding_applied.sql
--
-- Dropping this table restores the old behaviour exactly: a funding tick that
-- is retried after a restart decrements `margin_current` a second time for the
-- same period, and the trader's position liquidates early and releases short.
-- Reversible does not mean harmless — this is the door, re-opened.
--
-- The guard below refuses to roll back while any funding row exists. The rows are the only record of
-- which periods each position has already paid; with them gone a replayed tick charges them again.
-- No margin, no funding total and no ledger entry is written or unwritten by this file.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "trade"."position_funding_applied") THEN
    RAISE EXCEPTION 'trade.position_funding_applied has rows; they are the idempotency key for funding periods already paid, so rolling back would charge them again';
  END IF;
END
$$;

DROP INDEX IF EXISTS "trade"."position_funding_applied_period_idx";
DROP TABLE IF EXISTS "trade"."position_funding_applied";

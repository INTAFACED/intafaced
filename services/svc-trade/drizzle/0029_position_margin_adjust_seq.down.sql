-- intafaced:destructive — drops trade.position_margin_adjustments and positions.margin_adjust_seq / margin_adjust_request.
-- Reverse 0029_position_margin_adjust_seq.sql
--
-- The table, the counter and the pending request are how a live margin add or release is tied to the ledger post
-- key (futures.margin.* with the sequence). The guard below refuses to roll back while any adjustment row exists,
-- any position counter is past its starting value of 1, or any request is still pending.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "trade"."position_margin_adjustments")
     OR EXISTS (SELECT 1 FROM "trade"."positions" WHERE "margin_adjust_seq" > 1 OR "margin_adjust_request" IS NOT NULL) THEN
    RAISE EXCEPTION 'live margin adjustments exist; they attribute ledger margin posts to positions, so settle or archive them before rolling back';
  END IF;
END
$$;

DROP INDEX IF EXISTS "trade"."position_margin_adjustments_one_pending_idx";
DROP TABLE IF EXISTS "trade"."position_margin_adjustments";
ALTER TABLE "trade"."positions" DROP CONSTRAINT IF EXISTS "positions_margin_adjust_seq_ck";
ALTER TABLE "trade"."positions" DROP COLUMN IF EXISTS "margin_adjust_request";
ALTER TABLE "trade"."positions" DROP COLUMN IF EXISTS "margin_adjust_seq";

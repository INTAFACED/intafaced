-- trade.copy · the market a listed leader trades in (CB-copy-01, J-copy-bots-otc-01 #2)
-- Reversal: 0103_copy_leader_market_mode.down.sql
--
-- The copy room's Futures, Spot, Bots and Signal tabs filter the directory on the server by this column.
-- Every listing written before this column existed was a spot leader (copy places spot limits only), so
-- existing rows read 'spot'. The operator sets it on each later write.
ALTER TABLE trade.copy_leader_listings
  ADD COLUMN IF NOT EXISTS market_mode text NOT NULL DEFAULT 'spot';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'copy_leader_listings_mode_ck') THEN
    ALTER TABLE trade.copy_leader_listings
      ADD CONSTRAINT copy_leader_listings_mode_ck CHECK (market_mode IN ('spot', 'futures', 'bot', 'signal'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS copy_leader_listings_mode_order_idx
  ON trade.copy_leader_listings (market_mode, listed_at, leader_ref)
  WHERE state = 'listed';

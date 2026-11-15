-- J-cex-spot-14 #1 (SP-markets-data-02): a delisting is dated. A market that is being delisted keeps the date it leaves
-- the board, so the markets list can say "Delisting 16 Nov" instead of a bare state. Only a delisted listing may carry
-- one: an open, pending or halted market has no delisting date.
ALTER TABLE trade.markets
  ADD COLUMN IF NOT EXISTS delists_at timestamptz;

ALTER TABLE trade.markets DROP CONSTRAINT IF EXISTS markets_delists_at_ck;
ALTER TABLE trade.markets
  ADD CONSTRAINT markets_delists_at_ck CHECK (delists_at IS NULL OR status = 'delisted');

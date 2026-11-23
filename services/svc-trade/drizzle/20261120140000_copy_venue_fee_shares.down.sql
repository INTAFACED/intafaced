-- intafaced:destructive — reversal of 20261120140000_copy_venue_fee_shares.sql. The venue rows go with their columns; the
-- ledger's own transactions stay: they are the record of what was owed.
DROP TABLE IF EXISTS trade.copy_fee_share_funds;
DROP INDEX IF EXISTS trade.copy_settled_fee_shares_venue_idx;
ALTER TABLE trade.copy_settled_fee_shares DROP CONSTRAINT IF EXISTS copy_settled_fee_shares_venue_ck;
DELETE FROM trade.copy_settled_fee_shares WHERE venue_id IS NOT NULL;
ALTER TABLE trade.copy_settled_fee_shares DROP COLUMN IF EXISTS owe_tx_id;
ALTER TABLE trade.copy_settled_fee_shares DROP COLUMN IF EXISTS claim_id;
ALTER TABLE trade.copy_settled_fee_shares DROP COLUMN IF EXISTS filled_at;
ALTER TABLE trade.copy_settled_fee_shares DROP COLUMN IF EXISTS leader_fill_id;
ALTER TABLE trade.copy_settled_fee_shares DROP COLUMN IF EXISTS venue_fill_id;
ALTER TABLE trade.copy_settled_fee_shares DROP COLUMN IF EXISTS venue_account;
ALTER TABLE trade.copy_settled_fee_shares DROP COLUMN IF EXISTS venue_id;

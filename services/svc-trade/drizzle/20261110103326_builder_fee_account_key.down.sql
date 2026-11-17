-- Reverses 20261110103326_builder_fee_account_key.sql. Rows of two accounts under one fill id, and not_our_order rows,
-- don't fit the earlier key and checks, so they are removed first; the ledger's own transactions stay: they are the record.
DROP TABLE IF EXISTS trade.venue_builder_fee_runs;
DELETE FROM trade.venue_builder_fees WHERE status = 'not_our_order';
DELETE FROM trade.venue_builder_fees f
 USING trade.venue_builder_fees g
 WHERE f.venue_id = g.venue_id AND f.fill_id = g.fill_id AND f.venue_account > g.venue_account;
ALTER TABLE trade.venue_builder_fees DROP CONSTRAINT IF EXISTS venue_builder_fees_outcome_ck;
ALTER TABLE trade.venue_builder_fees ADD CONSTRAINT venue_builder_fees_outcome_ck CHECK (
  (status = 'posted' AND ledger_tx_id IS NOT NULL AND refusal_code IS NULL)
  OR (status = 'refused' AND ledger_tx_id IS NULL AND refusal_code IS NOT NULL)
);
ALTER TABLE trade.venue_builder_fees DROP CONSTRAINT IF EXISTS venue_builder_fees_status_ck;
ALTER TABLE trade.venue_builder_fees ADD CONSTRAINT venue_builder_fees_status_ck CHECK (status IN ('posted', 'refused'));
ALTER TABLE trade.venue_builder_fees DROP CONSTRAINT IF EXISTS venue_builder_fees_pkey;
ALTER TABLE trade.venue_builder_fees ADD CONSTRAINT venue_builder_fees_pkey PRIMARY KEY (venue_id, fill_id);
ALTER TABLE trade.venue_builder_fees DROP CONSTRAINT IF EXISTS venue_builder_fees_account_ck;
ALTER TABLE trade.venue_builder_fees DROP COLUMN IF EXISTS venue_account;

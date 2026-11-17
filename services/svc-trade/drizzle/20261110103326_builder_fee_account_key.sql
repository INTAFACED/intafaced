-- trade.venue_builder_fees keyed by venue account, "not our order", and the poster's runs (OWNER 288, changes 1a to 1c)
-- Reversal: 20261110103326_builder_fee_account_key.down.sql
--
-- 1a. The ledger key of a builder fee earned names the venue account: `builder-fee:<venue_id>:<venue_account>:<fill_id>`,
-- because the two sides of one trade can be two of our accounts under one fill id. This table follows it: one row per
-- venue, account and fill. `venue_account` is the key's account part: the owner, or `<owner>/<sub_account>`.
-- 1b. A fill with a builder fee on an order our door never stored before sending is recorded as `not_our_order` and is
-- never posted: the venue does not say whose builder fee it is, and it is not ours to book.
-- 1c. `venue_builder_fee_runs` keeps, per venue, when the poster last completed a run and the last stop, so the
-- operations desk shows the time since the last complete run. Never a balance.

ALTER TABLE trade.venue_builder_fees ADD COLUMN IF NOT EXISTS venue_account text;
UPDATE trade.venue_builder_fees
   SET venue_account = CASE WHEN sub_account IS NULL THEN owner ELSE owner || '/' || sub_account END
 WHERE venue_account IS NULL;
ALTER TABLE trade.venue_builder_fees ALTER COLUMN venue_account SET NOT NULL;
ALTER TABLE trade.venue_builder_fees DROP CONSTRAINT IF EXISTS venue_builder_fees_account_ck;
ALTER TABLE trade.venue_builder_fees ADD CONSTRAINT venue_builder_fees_account_ck CHECK (venue_account ~ '^[^[:space:]:]+$');
ALTER TABLE trade.venue_builder_fees DROP CONSTRAINT IF EXISTS venue_builder_fees_pkey;
ALTER TABLE trade.venue_builder_fees ADD CONSTRAINT venue_builder_fees_pkey PRIMARY KEY (venue_id, venue_account, fill_id);

ALTER TABLE trade.venue_builder_fees DROP CONSTRAINT IF EXISTS venue_builder_fees_status_ck;
ALTER TABLE trade.venue_builder_fees ADD CONSTRAINT venue_builder_fees_status_ck
  CHECK (status IN ('posted', 'refused', 'not_our_order'));
ALTER TABLE trade.venue_builder_fees DROP CONSTRAINT IF EXISTS venue_builder_fees_outcome_ck;
ALTER TABLE trade.venue_builder_fees ADD CONSTRAINT venue_builder_fees_outcome_ck CHECK (
  (status = 'posted' AND ledger_tx_id IS NOT NULL AND refusal_code IS NULL)
  OR (status = 'refused' AND ledger_tx_id IS NULL AND refusal_code IS NOT NULL)
  OR (status = 'not_our_order' AND ledger_tx_id IS NULL AND refusal_code IS NULL)
);

CREATE TABLE IF NOT EXISTS trade.venue_builder_fee_runs (
  venue_id text PRIMARY KEY,
  last_complete_at timestamptz,
  last_stop_at timestamptz,
  last_stop jsonb
);

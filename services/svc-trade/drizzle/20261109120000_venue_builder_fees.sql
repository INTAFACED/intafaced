-- trade.venue_builder_fees · which venue fills had our builder fee posted to the ledger (D-venue-07; J-derivatives-17)
-- Reversal: 20261109120000_venue_builder_fees.down.sql
--
-- The builder-fee poster (src/venue/builder-fee-poster.ts) reads our users' venue fills and posts `builderFeeEarn` for
-- each fill that carried our builder fee, keyed `builder-fee:<venue_id>:<fill_id>`. This table records which fills it
-- has posted, or that the ledger refused (an unknown fee asset), so the recon can list the ledger's side and the poster
-- can read on from where it was. It is never a balance: the ledger is the record of the fee earned, and the recon reads
-- the amount from the ledger's own transaction under the key. `amount` is the venue's figure as it was read.

CREATE TABLE IF NOT EXISTS trade.venue_builder_fees (
  venue_id text NOT NULL,
  fill_id text NOT NULL,
  user_id text NOT NULL CONSTRAINT venue_builder_fees_user_ck CHECK (length(btrim(user_id)) > 0),
  owner text NOT NULL,
  sub_account text,
  asset_id text NOT NULL,
  amount text NOT NULL CONSTRAINT venue_builder_fees_amount_ck CHECK (amount ~ '^[0-9]+(\.[0-9]+)?$'),
  filled_at timestamptz NOT NULL,
  status text NOT NULL CONSTRAINT venue_builder_fees_status_ck CHECK (status IN ('posted', 'refused')),
  refusal_code text,
  ledger_tx_id text,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (venue_id, fill_id),
  CONSTRAINT venue_builder_fees_outcome_ck CHECK (
    (status = 'posted' AND ledger_tx_id IS NOT NULL AND refusal_code IS NULL)
    OR (status = 'refused' AND ledger_tx_id IS NULL AND refusal_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS venue_builder_fees_period_idx ON trade.venue_builder_fees (venue_id, filled_at);
CREATE INDEX IF NOT EXISTS venue_builder_fees_account_idx ON trade.venue_builder_fees (venue_id, owner, filled_at);

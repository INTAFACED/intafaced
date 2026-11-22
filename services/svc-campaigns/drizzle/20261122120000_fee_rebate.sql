-- J-campaigns-09 #5 #6, CM-vouchers-coupons-03: a fee rebate coupon. A voucher of a fee rebate campaign pays
-- `fee_rebate_bps` of our builder fee back on each eligible venue fill, up to its face value (the campaign's reward, in
-- its budget's asset). Each fill accrues once, keyed by the venue's own fill (venue, venue account, fill id) per account,
-- so a fill read again accrues nothing more. Each accrual is one redemption of the voucher: a reward intent owed from the
-- campaign's budget and held until `delay` after it accrued, then paid to the connected wallet by the reward payer.

ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS fee_rebate_bps integer;
ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS fee_rebate_delay_seconds integer;
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_kind_ck;
ALTER TABLE campaigns.vouchers ADD CONSTRAINT vouchers_kind_ck CHECK (
  (kind = 'cash' AND fee_discount_bps IS NULL AND fee_rebate_bps IS NULL AND fee_rebate_delay_seconds IS NULL)
  OR (kind = 'fee_saver' AND fee_discount_bps BETWEEN 1 AND 10000 AND face_asset = 'ORDERS' AND face_amount = trunc(face_amount)
    AND fee_rebate_bps IS NULL AND fee_rebate_delay_seconds IS NULL)
  OR (kind = 'fee_rebate' AND fee_discount_bps IS NULL AND fee_rebate_bps BETWEEN 1 AND 10000
    AND fee_rebate_delay_seconds BETWEEN 0 AND 31536000 AND face_asset <> 'ORDERS')
);

CREATE TABLE IF NOT EXISTS campaigns.fee_rebate_accruals (
  account_id text NOT NULL,
  venue_id text NOT NULL,
  venue_account text NOT NULL,
  fill_id text NOT NULL,
  voucher_id text NOT NULL REFERENCES campaigns.vouchers (id),
  sequence integer NOT NULL,
  -- The venue's own builder fee on the fill, as it reported it, and what was accrued back of it.
  builder_fee numeric NOT NULL,
  amount numeric NOT NULL,
  filled_at timestamptz NOT NULL,
  reward_key text NOT NULL UNIQUE REFERENCES campaigns.reward_intents (reward_key),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, venue_id, venue_account, fill_id),
  CONSTRAINT fee_rebate_accruals_sequence_uq UNIQUE (voucher_id, sequence),
  CONSTRAINT fee_rebate_accruals_sequence_ck CHECK (sequence >= 1),
  CONSTRAINT fee_rebate_accruals_amount_ck CHECK (amount > 0 AND builder_fee > 0 AND amount <= builder_fee)
);
CREATE INDEX IF NOT EXISTS fee_rebate_accruals_voucher_idx ON campaigns.fee_rebate_accruals (voucher_id, sequence);

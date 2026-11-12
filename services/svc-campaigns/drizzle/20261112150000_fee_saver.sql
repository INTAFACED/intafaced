-- J-campaigns-09 #1-#3, CM-vouchers-coupons-02: a fee-saver coupon. A voucher of a fee-saver campaign takes its
-- campaign's discount (a fraction of our builder fee) off up to `fee_orders` venue orders; its face is those orders. It
-- moves no value: svc-trade signs the lower builder fee into the order and the venue charges it (ENGINE VC-9). Each order
-- it is taken on is one row here, keyed by the account's own order key, so one order takes one use, once.

ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cash';
ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS fee_discount_bps integer;
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_kind_ck;
ALTER TABLE campaigns.vouchers ADD CONSTRAINT vouchers_kind_ck CHECK (
  (kind = 'cash' AND fee_discount_bps IS NULL)
  OR (kind = 'fee_saver' AND fee_discount_bps BETWEEN 1 AND 10000 AND face_asset = 'ORDERS' AND face_amount = trunc(face_amount))
);

CREATE TABLE IF NOT EXISTS campaigns.fee_saver_uses (
  voucher_id text NOT NULL REFERENCES campaigns.vouchers (id),
  account_id text NOT NULL,
  -- svc-trade's own business key for the order (`order:<owner>:<intent>`), unique per account.
  order_key text NOT NULL,
  sequence integer NOT NULL,
  discount_bps integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, order_key),
  CONSTRAINT fee_saver_uses_sequence_uq UNIQUE (voucher_id, sequence),
  CONSTRAINT fee_saver_uses_sequence_ck CHECK (sequence >= 1),
  CONSTRAINT fee_saver_uses_discount_ck CHECK (discount_bps BETWEEN 1 AND 10000)
);
CREATE INDEX IF NOT EXISTS fee_saver_uses_voucher_idx ON campaigns.fee_saver_uses (voucher_id, sequence);

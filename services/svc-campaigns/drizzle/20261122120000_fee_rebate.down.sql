-- intafaced:destructive reversal of 20261122120000_fee_rebate.sql: drops the fee rebate accruals and terms
-- Refuses while a fee rebate voucher is issued: dropping it would silently lose which fills accrued which rebate.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.vouchers WHERE kind = 'fee_rebate') THEN
    RAISE EXCEPTION 'campaigns: a fee rebate voucher is issued; fee rebate vouchers are never dropped by reversing this migration';
  END IF;
END $$;
DROP TABLE IF EXISTS campaigns.fee_rebate_accruals;
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_kind_ck;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS fee_rebate_delay_seconds;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS fee_rebate_bps;
ALTER TABLE campaigns.vouchers ADD CONSTRAINT vouchers_kind_ck CHECK (
  (kind = 'cash' AND fee_discount_bps IS NULL)
  OR (kind = 'fee_saver' AND fee_discount_bps BETWEEN 1 AND 10000 AND face_asset = 'ORDERS' AND face_amount = trunc(face_amount))
);

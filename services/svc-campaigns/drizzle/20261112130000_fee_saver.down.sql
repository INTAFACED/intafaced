-- intafaced:destructive reversal of 20261112130000_fee_saver.sql: drops the fee-saver uses and the voucher kind
-- Refuses while a fee-saver voucher is issued: dropping it would silently lose which orders took which coupon.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.vouchers WHERE kind <> 'cash') THEN
    RAISE EXCEPTION 'campaigns: a fee-saver voucher is issued; fee-saver vouchers are never dropped by reversing this migration';
  END IF;
END $$;
DROP TABLE IF EXISTS campaigns.fee_saver_uses;
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_kind_ck;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS fee_discount_bps;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS kind;

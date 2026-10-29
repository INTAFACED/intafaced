-- Refuses while a voucher is issued: dropping the table would silently lose vouchers and the face values they carry.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.vouchers) THEN
    RAISE EXCEPTION 'campaigns: a voucher is issued; vouchers are never dropped by reversing this migration';
  END IF;
END $$;
DROP TABLE IF EXISTS campaigns.vouchers;

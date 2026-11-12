-- Reverse 20261112160000_signal_listings.sql
-- A paid signal payment is money history (our revenue and the partner's settlement are posted against it): refuse.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM market.signal_payments WHERE status IN ('approved', 'paid')) THEN
    RAISE EXCEPTION 'market.signal_payments_downgrade_refused: taken signal payments cannot be discarded'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
DROP TABLE IF EXISTS market.signal_payments;
DROP TABLE IF EXISTS market.signal_listings;

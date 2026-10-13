-- intafaced:destructive — dispatch receipts cannot be reconstructed from balances.
LOCK TABLE pay.withdrawals, pay.withdrawal_rail_attempts IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pay.withdrawal_rail_attempts) OR EXISTS (SELECT 1 FROM pay.withdrawals) THEN
    RAISE EXCEPTION 'pay.withdrawal_rail_attempts history prevents downgrade';
  END IF;
END $$;
DROP TABLE pay.withdrawal_rail_attempts;
DROP TRIGGER withdrawal_terms_frozen_trg ON pay.withdrawals;
DROP FUNCTION pay.withdrawal_terms_frozen();

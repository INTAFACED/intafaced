-- intafaced:destructive — a matched credit is an audit of a bank line; refuse to drop it once any credit was admitted.
LOCK TABLE pay.b2b_ramp_credits, pay.b2b_ramp_bank_lines IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pay.b2b_ramp_credits) THEN
    RAISE EXCEPTION 'pay.b2b_ramp_credits prevents downgrade';
  END IF;
END $$;
DROP TRIGGER IF EXISTS b2b_ramp_credits_append_only_trg ON pay.b2b_ramp_credits;
DROP TRIGGER IF EXISTS b2b_ramp_bank_lines_append_only_trg ON pay.b2b_ramp_bank_lines;
DROP TABLE pay.b2b_ramp_credits;
DROP TABLE pay.b2b_ramp_bank_lines;
DROP FUNCTION pay.b2b_ramp_credits_append_only();
DROP FUNCTION pay.b2b_ramp_bank_lines_append_only();

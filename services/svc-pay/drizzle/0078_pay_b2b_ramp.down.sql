-- intafaced:destructive — a bank line, and a credit matched to one, is an audit; refuse to drop either once any row exists.
LOCK TABLE pay.b2b_ramp_credits, pay.b2b_ramp_bank_lines IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pay.b2b_ramp_credits) THEN
    RAISE EXCEPTION 'pay.b2b_ramp_credits prevents downgrade';
  END IF;
  IF EXISTS (SELECT 1 FROM pay.b2b_ramp_bank_lines) THEN
    RAISE EXCEPTION 'pay.b2b_ramp_bank_lines prevents downgrade';
  END IF;
END $$;
DROP TRIGGER IF EXISTS b2b_ramp_credits_append_only_trg ON pay.b2b_ramp_credits;
DROP TRIGGER IF EXISTS b2b_ramp_bank_lines_append_only_trg ON pay.b2b_ramp_bank_lines;
DROP TABLE pay.b2b_ramp_credits;
DROP TABLE pay.b2b_ramp_bank_lines;
DROP FUNCTION pay.b2b_ramp_credits_append_only();
DROP FUNCTION pay.b2b_ramp_bank_lines_append_only();

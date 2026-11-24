-- Reverses 20261024143716. Fails closed: a correction is a record of what a loan owes, so this never deletes one.
-- With no corrections, it drops the append-only triggers and the empty table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."loan_adjustments") THEN
    RAISE EXCEPTION 'loan interest corrections exist; they are part of what loans owe, so 20261024143716 is not reversed';
  END IF;
END $$;

DROP TRIGGER IF EXISTS "loan_adjustments_append_only_trg" ON "bank"."loan_adjustments";
DROP TRIGGER IF EXISTS "loan_interest_accruals_append_only_trg" ON "bank"."loan_interest_accruals";
DROP FUNCTION IF EXISTS "bank"."loan_interest_rows_append_only"();
DROP TABLE IF EXISTS "bank"."loan_adjustments";

-- opening_collateral is the amount pledged at insert. 0008 checks that the
-- column is NULL or positive, so a later UPDATE can replace one positive
-- amount with another, or fill a legacy NULL. Rows that never locked stay
-- NULL, and the same-terms compare runs only when the column is set.
--
-- A BEFORE UPDATE trigger refuses a change of opening_collateral. Raising
-- aborts the statement, so the stored value stays. A NULL legacy row stays
-- NULL. The positive CHECK from 0008 stays. This file does not UPDATE,
-- DELETE, or INSERT loan rows.
--
-- Reversal: 0028_loan_opening_collateral_write_once.down.sql

CREATE OR REPLACE FUNCTION "bank"."loans_opening_collateral_write_once"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."opening_collateral" IS DISTINCT FROM OLD."opening_collateral" THEN
    RAISE EXCEPTION 'loan % opening_collateral is pledged at insert and cannot be rewritten', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "loans_opening_collateral_write_once_trg" ON "bank"."loans";
CREATE TRIGGER "loans_opening_collateral_write_once_trg"
  BEFORE UPDATE ON "bank"."loans"
  FOR EACH ROW EXECUTE FUNCTION "bank"."loans_opening_collateral_write_once"();

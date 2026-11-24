-- Interest corrections on a loan (LOAN-05, J-bank-11 #4): a correction is a new row, never an edit of a past day.
--
-- `loan_adjustments` holds one row per approved correction. `amount` is signed: below zero takes interest off the loan,
-- above zero adds interest the bank failed to charge. Each row names who proposed it, who approved it (two different
-- people) and the identity approval it consumed, so one approval writes at most one row. A correction moves no value:
-- like a day of accrual it changes what is owed, and the debt is still derived from the write-once rows
-- (`LoanService.outstanding()`), now with this leg.
--
-- Both interest tables are append-only from here: an UPDATE or DELETE of a day's accrual or of a correction raises.
-- Emptying a table in a test fixture fires no row trigger.
--
-- Reversal: 20261024143716_loan_interest_corrections.down.sql (refuses while any correction exists).

CREATE TABLE IF NOT EXISTS "bank"."loan_adjustments" (
  "id" uuid PRIMARY KEY,
  "loan_id" uuid NOT NULL REFERENCES "bank"."loans" ("id"),
  "kind" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "reason" text NOT NULL,
  "proposed_by" text NOT NULL,
  "approved_by" text NOT NULL,
  "approval_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "loan_adjustments_kind_ck" CHECK ("kind" IN ('interest_correction')),
  CONSTRAINT "loan_adjustments_amount_ck" CHECK ("amount" <> 0),
  CONSTRAINT "loan_adjustments_reason_ck" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "loan_adjustments_four_eyes_ck" CHECK (lower(btrim("proposed_by")) <> lower(btrim("approved_by")))
);
CREATE UNIQUE INDEX IF NOT EXISTS "loan_adjustments_approval_idx" ON "bank"."loan_adjustments" ("approval_id");
CREATE INDEX IF NOT EXISTS "loan_adjustments_loan_idx" ON "bank"."loan_adjustments" ("loan_id", "created_at");

CREATE OR REPLACE FUNCTION "bank"."loan_interest_rows_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% row % is append-only: write a correction instead', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER "loan_interest_accruals_append_only_trg"
  BEFORE UPDATE OR DELETE ON "bank"."loan_interest_accruals"
  FOR EACH ROW EXECUTE FUNCTION "bank"."loan_interest_rows_append_only"();

CREATE OR REPLACE TRIGGER "loan_adjustments_append_only_trg"
  BEFORE UPDATE OR DELETE ON "bank"."loan_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "bank"."loan_interest_rows_append_only"();

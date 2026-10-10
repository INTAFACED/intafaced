-- 0016 left business_payroll_runs.ledger_tx_id as text NOT NULL without
-- uniqueness and without rejecting ''. A database that already applied that
-- 0016 gains both constraints here. A fresh 0016 already created them, so
-- each add runs only when pg_constraint does not already have that name.
-- This file does not update, delete, or insert any row.
--
-- Reversal: 0031_business_payroll_ledger_tx_once.down.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'business_payroll_runs_ledger_tx_id_key'
  ) THEN
    ALTER TABLE "bank"."business_payroll_runs"
      ADD CONSTRAINT "business_payroll_runs_ledger_tx_id_key" UNIQUE ("ledger_tx_id");
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'business_payroll_runs_ledger_tx_id_nonblank'
  ) THEN
    ALTER TABLE "bank"."business_payroll_runs"
      ADD CONSTRAINT "business_payroll_runs_ledger_tx_id_nonblank"
      CHECK ("ledger_tx_id" <> '');
  END IF;
END
$$;

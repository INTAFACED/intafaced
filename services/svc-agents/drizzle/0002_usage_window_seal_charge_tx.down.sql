-- Reversal of 0002_usage_window_seal_charge_tx.sql.
--
-- Restores the seal function from before charge_tx_id was compared. Afterwards
-- a sealed window's ledger transaction id can be changed or cleared again, and
-- the reconciliation against svc-ledger can be pointed at a different
-- transaction or at none. This drops no table, no column, and no row.

CREATE OR REPLACE FUNCTION "agents"."usage_windows_seal_once"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."sealed_at" IS NOT NULL AND (
       NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at"
    OR NEW."charged_amount" IS DISTINCT FROM OLD."charged_amount"
    OR NEW."charge_key" IS DISTINCT FROM OLD."charge_key"
  ) THEN
    RAISE EXCEPTION 'usage window % for session % is already settled and cannot be re-settled',
      OLD."window_id", OLD."session_id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "usage_windows_seal_once" ON "agents"."usage_windows";
CREATE TRIGGER "usage_windows_seal_once"
  BEFORE UPDATE ON "agents"."usage_windows"
  FOR EACH ROW EXECUTE FUNCTION "agents"."usage_windows_seal_once"();

-- svc-agents · a sealed usage window keeps its ledger transaction id
-- Reversal: 0002_usage_window_seal_charge_tx.down.sql
--
-- `scripts/migrate.ts` records applied files by name in `agents.__migrations`.
-- `0000` has already run on existing databases, and editing that file does not
-- run again. This replaces `usage_windows_seal_once` so those databases get
-- the same check a fresh install gets from `0000`.
--
-- After `sealed_at` is set, changing or clearing a recorded `charge_tx_id`
-- raises restrict_violation, the same refusal as a change to `charged_amount`
-- or `charge_key`. The recorded ledger transaction id stays. An unsealed
-- window may still set it. A sealed window whose id is still null may receive
-- it once: settlement seals the amount before the ledger post and writes the
-- id afterwards. A second write, or a clear, is refused.

CREATE OR REPLACE FUNCTION "agents"."usage_windows_seal_once"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."sealed_at" IS NOT NULL AND (
       NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at"
    OR NEW."charged_amount" IS DISTINCT FROM OLD."charged_amount"
    OR NEW."charge_key" IS DISTINCT FROM OLD."charge_key"
    OR (
         OLD."charge_tx_id" IS NOT NULL
     AND NEW."charge_tx_id" IS DISTINCT FROM OLD."charge_tx_id"
       )
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

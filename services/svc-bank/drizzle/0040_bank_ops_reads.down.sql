DO $$
BEGIN
  IF to_regclass('bank.loans') IS NOT NULL THEN
    ALTER TABLE bank.loans DROP COLUMN IF EXISTS liquidation_ltv_bps;
    ALTER TABLE bank.loans DROP COLUMN IF EXISTS margin_call_ltv_bps;
  END IF;

  IF to_regclass('bank.card_operator_commands') IS NOT NULL THEN
    DROP TABLE bank.card_operator_commands;
  END IF;

  IF to_regclass('bank.cards') IS NOT NULL THEN
    ALTER TABLE bank.cards DROP CONSTRAINT IF EXISTS cards_operator_freeze_status_ck;
    ALTER TABLE bank.cards DROP CONSTRAINT IF EXISTS cards_frozen_by_ck;
    ALTER TABLE bank.cards DROP COLUMN IF EXISTS frozen_by;
  END IF;
END $$;

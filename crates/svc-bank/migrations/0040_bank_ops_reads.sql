-- Operator card freeze, and the LTV thresholds a loan agreed at opening (BANKOPS).
--
-- frozen_by records who froze a card. An operator freeze is not one the owner
-- can lift. The command table is the client idempotency key: a replay returns
-- the first result and does not post a second status change.
--
-- Loan margin-call and liquidation thresholds are copied from the product at
-- open. A later edit of the product must not re-band a loan somebody already
-- agreed. Rows that existed before this column are filled once from the product
-- as it stands at migration time; reads after that use the loan row only.
--
-- Each half runs only when its table is already there, so a suite that builds
-- just the card schema or just the loan schema can still apply this file.
--
-- Reversal: 0040_bank_ops_reads.down.sql

DO $$
BEGIN
  IF to_regclass('bank.cards') IS NOT NULL THEN
    ALTER TABLE bank.cards ADD COLUMN IF NOT EXISTS frozen_by text;
    ALTER TABLE bank.cards DROP CONSTRAINT IF EXISTS cards_frozen_by_ck;
    ALTER TABLE bank.cards
      ADD CONSTRAINT cards_frozen_by_ck CHECK (frozen_by IS NULL OR frozen_by IN ('owner', 'operator'));
    ALTER TABLE bank.cards DROP CONSTRAINT IF EXISTS cards_operator_freeze_status_ck;
    ALTER TABLE bank.cards
      ADD CONSTRAINT cards_operator_freeze_status_ck CHECK (frozen_by IS DISTINCT FROM 'operator' OR status = 'frozen');

    CREATE TABLE IF NOT EXISTS bank.card_operator_commands (
      client_request_id text PRIMARY KEY,
      card_id uuid NOT NULL REFERENCES bank.cards (id),
      target_status text NOT NULL,
      reason text NOT NULL,
      result_status text NOT NULL,
      frozen_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT card_operator_commands_status_ck CHECK (target_status IN ('frozen', 'active')),
      CONSTRAINT card_operator_commands_result_ck CHECK (result_status IN ('frozen', 'active')),
      CONSTRAINT card_operator_commands_reason_ck CHECK (char_length(reason) >= 10),
      CONSTRAINT card_operator_commands_frozen_by_ck CHECK (frozen_by IS NULL OR frozen_by = 'operator')
    );
  END IF;

  IF to_regclass('bank.loans') IS NOT NULL AND to_regclass('bank.loan_products') IS NOT NULL THEN
    ALTER TABLE bank.loans ADD COLUMN IF NOT EXISTS margin_call_ltv_bps integer;
    ALTER TABLE bank.loans ADD COLUMN IF NOT EXISTS liquidation_ltv_bps integer;
    UPDATE bank.loans AS l
       SET margin_call_ltv_bps = p.margin_call_ltv_bps,
           liquidation_ltv_bps = p.liquidation_ltv_bps
      FROM bank.loan_products AS p
     WHERE l.product_id = p.id
       AND l.margin_call_ltv_bps IS NULL
       AND l.liquidation_ltv_bps IS NULL;
  END IF;
END $$;

-- svc-pay · a checkout session merchant has to match the link and the payment.
-- Reversal: 0022_pay_checkout_session_merchant_match.down.sql
--
-- 0003 stores checkout_sessions.link_id, merchant_id, and payment_id as
-- independent foreign keys. link_id and merchant_id are NOT NULL. payment_id
-- is nullable. Nothing in that migration requires payment_links.merchant_id
-- to equal checkout_sessions.merchant_id, or payments.merchant_id to equal
-- either one. A mismatched insert freezes checkout_sessions.amount against a
-- different merchant than the link or the payment.
--
-- A CHECK constraint cannot subquery, so the refusal is a trigger, the same
-- shape as payments_amount_frozen. 0003 is already applied. This migration
-- does not UPDATE existing rows and does not assign an amount or a merchant.
-- The trigger returns the row unchanged: it does not rewrite amount,
-- currency, or rail_adapter.

CREATE OR REPLACE FUNCTION "pay"."checkout_sessions_merchant_match"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "pay"."payment_links"
     WHERE "id" = NEW."link_id"
       AND "merchant_id" = NEW."merchant_id"
  ) THEN
    RAISE EXCEPTION 'pay.checkout_sessions.merchant_id must equal the payment link merchant'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."payment_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM "pay"."payments"
     WHERE "id" = NEW."payment_id"
       AND "merchant_id" = NEW."merchant_id"
  ) THEN
    RAISE EXCEPTION 'pay.checkout_sessions.merchant_id must equal the payment merchant'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "checkout_sessions_merchant_match_trg" ON "pay"."checkout_sessions";
CREATE TRIGGER "checkout_sessions_merchant_match_trg"
  BEFORE INSERT OR UPDATE ON "pay"."checkout_sessions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."checkout_sessions_merchant_match"();

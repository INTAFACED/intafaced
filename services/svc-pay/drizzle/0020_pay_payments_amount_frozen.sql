-- svc-pay · payments.amount is the authorized amount and never changes.
-- Reversal: 0020_pay_payments_amount_frozen.down.sql
--
-- 0000 documents pay.payments.amount as the authorized amount. Capture and
-- refund ceilings are defined against it. Captured and refunded totals are
-- summed from payment_events. The append-only trigger on payment_events does
-- not cover this column, so an UPDATE could rewrite the authorization those
-- ceilings are measured against.
--
-- 0000 is already applied and the runner will not execute it again. This
-- migration only adds the refusal. It does not rewrite a stored amount, and
-- it does not insert a payment, a capture, or a refund.

CREATE OR REPLACE FUNCTION "pay"."payments_amount_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."amount" IS DISTINCT FROM OLD."amount" THEN
    RAISE EXCEPTION 'pay.payments.amount is the authorized amount and never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "payments_amount_frozen_trg" ON "pay"."payments";
CREATE TRIGGER "payments_amount_frozen_trg"
  BEFORE UPDATE ON "pay"."payments"
  FOR EACH ROW EXECUTE FUNCTION "pay"."payments_amount_frozen"();

-- svc-pay · payments.amount, currency, and rail_adapter are the authorization
-- and never change.
-- Reversal: 0020_pay_payments_amount_frozen.down.sql
--
-- 0000 documents pay.payments.amount as the authorized amount. Capture posts
-- that amount in payments.currency through payments.rail_adapter. Captured
-- and refunded totals are summed from payment_events. The append-only trigger
-- on payment_events does not cover these columns, so an UPDATE of amount,
-- currency, or rail_adapter rewrites the authorization those ceilings are
-- measured against, with no compensating event.
--
-- 0000 is already applied and the runner will not execute it again. This
-- migration only adds the refusal. It does not rewrite a stored amount,
-- currency, or rail_adapter, and it does not insert a payment, a capture,
-- or a refund.

CREATE OR REPLACE FUNCTION "pay"."payments_amount_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."amount" IS DISTINCT FROM OLD."amount" THEN
    RAISE EXCEPTION 'pay.payments.amount is the authorized amount and never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."currency" IS DISTINCT FROM OLD."currency" THEN
    RAISE EXCEPTION 'pay.payments.currency is the authorized currency and never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."rail_adapter" IS DISTINCT FROM OLD."rail_adapter" THEN
    RAISE EXCEPTION 'pay.payments.rail_adapter is the authorized rail and never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "payments_amount_frozen_trg" ON "pay"."payments";
CREATE TRIGGER "payments_amount_frozen_trg"
  BEFORE UPDATE ON "pay"."payments"
  FOR EACH ROW EXECUTE FUNCTION "pay"."payments_amount_frozen"();

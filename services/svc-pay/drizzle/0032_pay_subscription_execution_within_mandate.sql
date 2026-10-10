-- svc-pay · an execution amount cannot exceed the mandate amount or ceiling.
-- Reversal: 0032_pay_subscription_execution_within_mandate.down.sql
--
-- 0010 stores subscription_mandates.amount as the authorised charge and
-- ceiling as an optional cap, both numeric(38,18). subscription_executions.amount
-- is a separate numeric(38,18) checked only with amount > 0. Nothing compares
-- that amount to the parent mandate, so a settled row can journal a charge
-- above the mandate amount and above the ceiling. 0010 is already applied.
-- This file does not edit it. The amount > 0 check stays.
--
-- Postgres CHECK cannot subquery, so a BEFORE INSERT OR UPDATE trigger on
-- subscription_executions looks up the parent mandate through
-- subscriptions.mandate_id. NEW.amount greater than mandate.amount refuses.
-- When mandate.ceiling is not null and NEW.amount is greater than that
-- ceiling, it refuses. An amount equal to the mandate amount is allowed.
-- An amount equal to a non-null ceiling is allowed when that ceiling is also
-- equal to the amount, which is the only ceiling the existing CHECK
-- ceiling >= amount allows an equal charge to meet.
--
-- The refusal is ERRCODE 23514. The trigger returns NEW unchanged when the
-- amount is inside both bounds. It does not rewrite stored rows. It does not
-- add a NaN guard, a product magnitude, a ledger entry, or an upsert. Money
-- stays numeric.

CREATE OR REPLACE FUNCTION "pay"."subscription_executions_within_mandate"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mandate_amount numeric;
  mandate_ceiling numeric;
BEGIN
  SELECT m.amount, m.ceiling
    INTO mandate_amount, mandate_ceiling
    FROM "pay"."subscriptions" AS s
    JOIN "pay"."subscription_mandates" AS m
      ON m.id = s.mandate_id
   WHERE s.id = NEW.subscription_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_executions_within_mandate: parent mandate was not found'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.amount > mandate_amount THEN
    RAISE EXCEPTION 'subscription_executions_within_mandate: amount exceeds the mandate amount'
      USING ERRCODE = '23514';
  END IF;

  IF mandate_ceiling IS NOT NULL AND NEW.amount > mandate_ceiling THEN
    RAISE EXCEPTION 'subscription_executions_within_mandate: amount exceeds the mandate ceiling'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "subscription_executions_within_mandate_trg" ON "pay"."subscription_executions";
CREATE TRIGGER "subscription_executions_within_mandate_trg"
  BEFORE INSERT OR UPDATE ON "pay"."subscription_executions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."subscription_executions_within_mandate"();

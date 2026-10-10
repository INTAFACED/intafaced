-- intafaced:destructive — reversal of 0032_pay_subscription_execution_within_mandate.sql
--
-- Drops the trigger that refuses an execution amount above the parent mandate
-- amount or ceiling, and the function it calls. The amount > 0 check stays.
-- Stored rows stay. This reversal moves no value.

DROP TRIGGER IF EXISTS "subscription_executions_within_mandate_trg" ON "pay"."subscription_executions";
DROP FUNCTION IF EXISTS "pay"."subscription_executions_within_mandate"();

-- svc-pay · TRUNCATE of payment_events is refused.
-- Reversal: 0023_pay_payment_events_truncate.down.sql
--
-- intafaced:destructive — BEFORE TRUNCATE is the trigger event. This migration
-- does not TRUNCATE, UPDATE, or DELETE stored rows, and it does not insert an event.
--
-- payment_events_append_only is a BEFORE UPDATE OR DELETE row trigger.
-- TRUNCATE does not fire FOR EACH ROW triggers, and 0000 never adds a
-- BEFORE TRUNCATE statement trigger. These rows are the chargeback history
-- and the captured and refunded totals, so a TRUNCATE by the table owner
-- removes that log while the row trigger is still in place.
--
-- A TRUNCATE trigger has to be FOR EACH STATEMENT. This one calls the existing
-- payment_events_append_only function, which already raises for any TG_OP.
-- 0000 is already applied. This migration does not edit that function.

DROP TRIGGER IF EXISTS "payment_events_append_only_truncate_trg" ON "pay"."payment_events";
CREATE TRIGGER "payment_events_append_only_truncate_trg"
  BEFORE TRUNCATE ON "pay"."payment_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "pay"."payment_events_append_only"();

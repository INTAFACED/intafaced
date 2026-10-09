-- intafaced:destructive — reversal of 0026_pay_merchant_status_actor_not_blank.sql
--
-- Drops the checks that refuse a blank or space-only actor_id or actor_scope.
-- The columns stay text NOT NULL. The reason check stays. Stored rows stay.

ALTER TABLE "pay"."merchant_status_events"
  DROP CONSTRAINT IF EXISTS "merchant_status_events_actor_id_not_blank";

ALTER TABLE "pay"."merchant_status_events"
  DROP CONSTRAINT IF EXISTS "merchant_status_events_actor_scope_not_blank";

-- intafaced:destructive — reversal of 0035_pay_merchant_kyb_pricing_actor_not_blank.sql
--
-- Drops the checks that refuse a blank or space-only actor_id or actor_scope
-- on merchant_kyb_events and merchant_pricing_events. The columns stay text
-- NOT NULL. The reason checks stay. The fee range stays. The append-only
-- triggers stay. Stored rows stay.

ALTER TABLE "pay"."merchant_kyb_events"
  DROP CONSTRAINT IF EXISTS "merchant_kyb_events_actor_id_not_blank";

ALTER TABLE "pay"."merchant_kyb_events"
  DROP CONSTRAINT IF EXISTS "merchant_kyb_events_actor_scope_not_blank";

ALTER TABLE "pay"."merchant_pricing_events"
  DROP CONSTRAINT IF EXISTS "merchant_pricing_events_actor_id_not_blank";

ALTER TABLE "pay"."merchant_pricing_events"
  DROP CONSTRAINT IF EXISTS "merchant_pricing_events_actor_scope_not_blank";

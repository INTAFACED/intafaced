-- intafaced:destructive — reversal of 0028_pay_merchant_permission_area_actor_not_blank.sql
--
-- Drops the checks that refuse a blank or space-only area, actor_id, or
-- actor_scope. The columns stay text NOT NULL. The reason check stays.
-- Stored rows stay. This reversal moves no value.

ALTER TABLE "pay"."merchant_permission_events"
  DROP CONSTRAINT IF EXISTS "merchant_permission_events_area_not_blank";

ALTER TABLE "pay"."merchant_permission_events"
  DROP CONSTRAINT IF EXISTS "merchant_permission_events_actor_id_not_blank";

ALTER TABLE "pay"."merchant_permission_events"
  DROP CONSTRAINT IF EXISTS "merchant_permission_events_actor_scope_not_blank";

-- svc-pay · a permission event cannot record a blank area or actor.
-- Reversal: 0028_pay_merchant_permission_area_actor_not_blank.down.sql
--
-- 0009 stores merchant_permission_events.area, actor_id, and actor_scope as
-- text NOT NULL. reason already refuses a blank with
-- CHECK (length(btrim("reason")) > 0). NOT NULL still admits '' and a string
-- of spaces on the area and actor columns. A grant or revoke with a blank
-- area, or an actor_id of spaces, is a legal authorization event, and the
-- triple index returns it as the latest decision for that key. A blank actor
-- fails the question the journal exists to answer: who granted or revoked,
-- and under what authority. A blank area is not a permission. The append-only
-- trigger rejects an in-place repair, so this file only adds checks. It does
-- not invent an actor. It does not name permission areas and does not turn
-- area into an enum. If a stored row is already blank, ADD CONSTRAINT fails
-- and that row stays. 0009 is already applied. No merchant value moves. This
-- file has no amount column.

ALTER TABLE "pay"."merchant_permission_events"
  ADD CONSTRAINT "merchant_permission_events_area_not_blank"
  CHECK (length(btrim("area")) > 0);

ALTER TABLE "pay"."merchant_permission_events"
  ADD CONSTRAINT "merchant_permission_events_actor_id_not_blank"
  CHECK (length(btrim("actor_id")) > 0);

ALTER TABLE "pay"."merchant_permission_events"
  ADD CONSTRAINT "merchant_permission_events_actor_scope_not_blank"
  CHECK (length(btrim("actor_scope")) > 0);

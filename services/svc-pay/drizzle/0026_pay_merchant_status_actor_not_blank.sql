-- svc-pay · a merchant status event cannot record a blank actor.
-- Reversal: 0026_pay_merchant_status_actor_not_blank.down.sql
--
-- 0006 stores merchant_status_events.actor_id and actor_scope as text NOT NULL.
-- reason already refuses a blank with CHECK (length(btrim(reason)) > 0). NOT
-- NULL still admits '' and a string of spaces on the actor columns. A blank
-- actor fails the question the history exists to answer: who changed the
-- merchant, and under what authority. The append-only trigger rejects an
-- in-place repair, so this file only adds checks. It does not invent an actor.
-- If a stored row is already blank, ADD CONSTRAINT fails and that row stays.
-- 0006 is already applied.

ALTER TABLE "pay"."merchant_status_events"
  ADD CONSTRAINT "merchant_status_events_actor_id_not_blank"
  CHECK (length(btrim("actor_id")) > 0);

ALTER TABLE "pay"."merchant_status_events"
  ADD CONSTRAINT "merchant_status_events_actor_scope_not_blank"
  CHECK (length(btrim("actor_scope")) > 0);

-- svc-pay · a KYB or pricing event cannot record a blank actor.
-- Reversal: 0035_pay_merchant_kyb_pricing_actor_not_blank.down.sql
--
-- 0013 stores merchant_kyb_events.actor_id and actor_scope, and
-- merchant_pricing_events.actor_id and actor_scope, as text NOT NULL.
-- reason on both tables already refuses a blank with
-- CHECK (length(btrim(reason)) > 0). NOT NULL still admits '' and a string
-- of spaces on the actor columns. A KYB transition or a fee-bps change with
-- a blank actor fails the question the history exists to answer: who changed
-- it, and under what authority. The append-only triggers reject an in-place
-- repair, so this file only adds checks. It does not invent an actor, a KYB
-- vendor, or a fee. It does not change the fee range, the reason checks, or
-- the append-only triggers. It does not UPDATE stored rows. If a stored row
-- is already blank, ADD CONSTRAINT fails and that row stays. 0013 is already
-- applied.

ALTER TABLE "pay"."merchant_kyb_events"
  ADD CONSTRAINT "merchant_kyb_events_actor_id_not_blank"
  CHECK (length(btrim("actor_id")) > 0);

ALTER TABLE "pay"."merchant_kyb_events"
  ADD CONSTRAINT "merchant_kyb_events_actor_scope_not_blank"
  CHECK (length(btrim("actor_scope")) > 0);

ALTER TABLE "pay"."merchant_pricing_events"
  ADD CONSTRAINT "merchant_pricing_events_actor_id_not_blank"
  CHECK (length(btrim("actor_id")) > 0);

ALTER TABLE "pay"."merchant_pricing_events"
  ADD CONSTRAINT "merchant_pricing_events_actor_scope_not_blank"
  CHECK (length(btrim("actor_scope")) > 0);

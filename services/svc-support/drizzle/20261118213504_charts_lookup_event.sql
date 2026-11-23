-- svc-support · a support agent's charts lookup is a trail row (C-ops-03 (a), J-charts-desk-19 #1). Reversal: the .down.sql
-- of the same name.
--
-- `charts_lookup` records that an operator read the ticket owner's price alerts, their trigger history and saved desk
-- layouts: the actor is the agent, the note names the customer, `occurred_at` is the time. The row is written before
-- anything is read, and a lookup whose row did not land is refused.
ALTER TABLE "support"."ticket_events" DROP CONSTRAINT IF EXISTS "ticket_events_kind_ck";
ALTER TABLE "support"."ticket_events" ADD CONSTRAINT "ticket_events_kind_ck"
  CHECK ("kind" IN ('opened', 'assigned', 'status_changed', 'grounding_read', 'escalated', 'merged', 'charts_lookup'));

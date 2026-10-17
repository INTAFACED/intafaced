-- intafaced:destructive — reversal of 0070_pay_registry_events.sql
--
-- Drops the registry audit trail. This deletes history, so it is for CI proof
-- of reversibility and for a database that never held a real change.

DROP TRIGGER IF EXISTS "registry_events_append_only_trg" ON "pay"."registry_events";
DROP FUNCTION IF EXISTS "pay"."registry_events_append_only"();
DROP INDEX IF EXISTS "pay"."registry_events_entry_idx";
DROP TABLE IF EXISTS "pay"."registry_events";

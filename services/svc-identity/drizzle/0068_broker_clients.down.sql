-- Reverses 0068_broker_clients.sql. Broker links, history, schedules and allocation records are dropped.
DROP TABLE IF EXISTS "identity"."broker_allocations";
DROP TRIGGER IF EXISTS "broker_commission_schedules_immutable" ON "identity"."broker_commission_schedules";
DROP TABLE IF EXISTS "identity"."broker_commission_schedules";
DROP FUNCTION IF EXISTS "identity"."broker_commission_schedules_immutable"();
DROP TABLE IF EXISTS "identity"."broker_client_events";
DROP TABLE IF EXISTS "identity"."broker_clients";

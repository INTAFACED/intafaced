-- Reverses 20261025020000_vip_applications.sql. The applications and their encrypted proofs are dropped with them.
DROP TABLE IF EXISTS "trade"."vip_application_events";
DROP FUNCTION IF EXISTS "trade"."vip_application_events_append_only"();
DROP TABLE IF EXISTS "trade"."vip_applications";
DROP FUNCTION IF EXISTS "trade"."vip_applications_status_only"();

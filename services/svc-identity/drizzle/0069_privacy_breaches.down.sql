-- Reverses 0069_privacy_breaches.sql. The breach log and its pending notices are dropped.
DROP TABLE IF EXISTS "identity"."privacy_breach_notices";
DROP TABLE IF EXISTS "identity"."privacy_breaches";

-- Reverse 0021_rating_requests.sql
-- Lossy: the record of which resolved tickets were already announced is dropped.
DROP TRIGGER IF EXISTS "tickets_record_rating_request" ON "support"."tickets";
DROP FUNCTION IF EXISTS "support"."tickets_record_rating_request"();
DROP TABLE IF EXISTS "support"."rating_requests";

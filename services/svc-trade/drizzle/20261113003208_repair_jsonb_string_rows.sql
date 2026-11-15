-- svc-trade · repair jsonb columns that hold a JSON string instead of the value (#4615)
-- Reversal: 20261113003208_repair_jsonb_string_rows.down.sql
--
-- Before #4608 and #4616, these columns were written with `${text}::jsonb`,
-- which postgres.js stores as a JSON *string* holding the text of the value.
-- This re-reads each such string as the JSON it holds. A string whose text is
-- not valid JSON is left as it is: there is no value to recover from it.
-- Safe to re-run: a repaired row is no longer a string.

UPDATE "trade"."copy_follows"
   SET "permitted_markets" = ("permitted_markets" #>> '{}')::jsonb
 WHERE jsonb_typeof("permitted_markets") = 'string'
   AND pg_input_is_valid("permitted_markets" #>> '{}', 'jsonb');

UPDATE "trade"."orders"
   SET "lifecycle_proof" = ("lifecycle_proof" #>> '{}')::jsonb
 WHERE jsonb_typeof("lifecycle_proof") = 'string'
   AND pg_input_is_valid("lifecycle_proof" #>> '{}', 'jsonb');

UPDATE "trade"."market_lifecycle_evidence"
   SET "publication" = ("publication" #>> '{}')::jsonb
 WHERE jsonb_typeof("publication") = 'string'
   AND pg_input_is_valid("publication" #>> '{}', 'jsonb');

UPDATE "trade"."market_lifecycle_evidence"
   SET "transition" = ("transition" #>> '{}')::jsonb
 WHERE jsonb_typeof("transition") = 'string'
   AND pg_input_is_valid("transition" #>> '{}', 'jsonb');

UPDATE "trade"."market_lifecycle_evidence"
   SET "correction" = ("correction" #>> '{}')::jsonb
 WHERE jsonb_typeof("correction") = 'string'
   AND pg_input_is_valid("correction" #>> '{}', 'jsonb');

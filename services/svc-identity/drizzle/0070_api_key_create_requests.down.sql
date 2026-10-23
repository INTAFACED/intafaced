-- Reverses 0070_api_key_create_requests.sql. Keys already made stay; only the request ids that answered repeats go.
DROP INDEX IF EXISTS "identity"."api_keys_user_lower_name_idx";
DROP TABLE IF EXISTS "identity"."api_key_create_requests";

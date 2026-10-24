-- intafaced:destructive drops every customer's limit overrides and their history. The base limits live with the services
-- that enforce them and are untouched; without an override each customer is back on them.
DROP TABLE IF EXISTS "identity"."account_limit_events";
DROP TABLE IF EXISTS "identity"."account_limit_overrides";

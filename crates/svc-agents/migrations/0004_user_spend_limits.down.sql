-- intafaced:destructive — reversal of 0004_user_spend_limits.sql
DROP TABLE IF EXISTS "agents"."spend_reservations";
DROP TABLE IF EXISTS "agents"."spend_limit_requests";
DROP TABLE IF EXISTS "agents"."user_spend_limits";

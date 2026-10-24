-- Reverses 20261024232306_death_notices.sql.
-- intafaced:destructive drops every death notice record; accounts already frozen by a confirmed notice stay frozen.
DROP TABLE IF EXISTS "identity"."death_notices";

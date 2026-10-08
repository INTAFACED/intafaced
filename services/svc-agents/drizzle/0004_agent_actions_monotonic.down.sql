-- Reversal of 0004_agent_actions_monotonic.sql.
--
-- NOT tagged `intafaced:destructive`: this drops no table, no column and no
-- row. Afterwards a session can take an insert whose occurred_at precedes the
-- tip, or whose sequence sits behind it. The unique (session_id, sequence)
-- index is left in place.
--
-- It exists so the migration is provably reversible. Do not run it against a
-- database whose action log is evidence.

DROP TRIGGER IF EXISTS "agent_actions_occurred_monotonic" ON "agents"."agent_actions";
DROP FUNCTION IF EXISTS "agents"."agent_actions_occurred_monotonic"();

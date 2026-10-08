-- svc-agents · occurred_at stays monotonic inside a session
-- Reversal: 0004_agent_actions_monotonic.down.sql
--
-- NOT tagged `intafaced:destructive`: it drops no table, no column and no row.
--
-- `scripts/migrate.ts` records applied files by name in `agents.__migrations`.
-- `0000` has already run on existing databases, and editing that file does not
-- run again. The comment on `agent_actions_session_sequence_idx` says a
-- re-ordered or back-dated insert is impossible. The unique index only rejects
-- a duplicate (session_id, sequence). This is the check those databases get.
--
-- A new row for a session must sort after the tip: sequence strictly after the
-- highest sequence, and occurred_at at or after the latest occurred_at. An
-- earlier timestamp is back-dated. A sequence behind the tip is re-ordered,
-- including one that would sit in a gap. The same timestamp as the tip is
-- allowed, so two actions in one millisecond still append. A duplicate
-- (session_id, sequence) is still the unique index's refusal: this trigger
-- does not treat "equal to the tip" as its own error, so that insert reaches
-- the index.
--
-- The session row is locked first, the same lock `AuditLog.append` already
-- holds, so two inserts cannot both pass the read and then commit out of order.

CREATE OR REPLACE FUNCTION "agents"."agent_actions_occurred_monotonic"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_seq integer;
  prior_at timestamptz;
BEGIN
  PERFORM 1
    FROM "agents"."agent_sessions"
   WHERE "id" = NEW."session_id"
     FOR UPDATE;

  SELECT max(a."sequence"), max(a."occurred_at")
    INTO prior_seq, prior_at
    FROM "agents"."agent_actions" a
   WHERE a."session_id" = NEW."session_id";

  IF prior_seq IS NOT NULL AND NEW."sequence" < prior_seq THEN
    RAISE EXCEPTION 'agent_actions refuses a re-ordered insert for session %: sequence % is behind %',
      NEW."session_id", NEW."sequence", prior_seq
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF prior_at IS NOT NULL AND NEW."occurred_at" < prior_at THEN
    RAISE EXCEPTION 'agent_actions refuses a back-dated insert for session %: occurred_at % is before %',
      NEW."session_id", NEW."occurred_at", prior_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "agent_actions_occurred_monotonic" ON "agents"."agent_actions";
CREATE TRIGGER "agent_actions_occurred_monotonic"
  BEFORE INSERT ON "agents"."agent_actions"
  FOR EACH ROW EXECUTE FUNCTION "agents"."agent_actions_occurred_monotonic"();

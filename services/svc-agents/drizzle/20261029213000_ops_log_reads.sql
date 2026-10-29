-- svc-agents · the operator's read of a customer's agent log, and the kept transcript (AG-audit-01, AG-audit-02)
-- Reversal: 20261029213000_ops_log_reads.down.sql
--
-- `agent_log_reads`: one row per operator read of the action log, its export or one transcript, keyed on a business
-- key (`agents:logread:<operator>:<request id>`), so a retried read writes no second row. It names the operator, the
-- customer, the reason the operator picked from the owner's list, the filter and how many rows were shown. Append-only,
-- like agent_actions: an audit row is never rewritten.
--
-- `agent_transcripts`: the canonical prompt text of one executed engine call, kept only while the owner's transcript
-- retention (AGENTS_TRANSCRIPT_RETENTION_DAYS) is above zero, written in the same transaction as the action row. Its
-- sha256 is the action row's input_digest. A row past `expires_at` is never read and is purged.

CREATE TABLE IF NOT EXISTS "agents"."agent_log_reads" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_key"  text NOT NULL UNIQUE,
  "operator_id"   text NOT NULL,
  "subject_id"    text NOT NULL,
  "kind"          text NOT NULL,
  "reason"        text NOT NULL,
  "filter"        jsonb NOT NULL DEFAULT '{}'::jsonb,
  "action_id"     uuid REFERENCES "agents"."agent_actions" ("id"),
  "row_count"     integer NOT NULL,
  "read_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_log_reads_kind_ck" CHECK ("kind" IN ('actions', 'export', 'transcript')),
  CONSTRAINT "agent_log_reads_reason_ck" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "agent_log_reads_rows_ck" CHECK ("row_count" >= 0),
  CONSTRAINT "agent_log_reads_action_ck" CHECK (("kind" = 'transcript') = ("action_id" IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS "agent_log_reads_subject_idx" ON "agents"."agent_log_reads" ("subject_id", "read_at");

CREATE OR REPLACE FUNCTION "agents"."agent_log_reads_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent_log_reads is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "agent_log_reads_no_update" ON "agents"."agent_log_reads";
CREATE TRIGGER "agent_log_reads_no_update"
  BEFORE UPDATE ON "agents"."agent_log_reads"
  FOR EACH ROW EXECUTE FUNCTION "agents"."agent_log_reads_append_only"();

DROP TRIGGER IF EXISTS "agent_log_reads_no_delete" ON "agents"."agent_log_reads";
CREATE TRIGGER "agent_log_reads_no_delete"
  BEFORE DELETE ON "agents"."agent_log_reads"
  FOR EACH ROW EXECUTE FUNCTION "agents"."agent_log_reads_append_only"();

CREATE TABLE IF NOT EXISTS "agents"."agent_transcripts" (
  "action_id"   uuid PRIMARY KEY REFERENCES "agents"."agent_actions" ("id"),
  "user_id"     text NOT NULL,
  "text"        text NOT NULL,
  "stored_at"   timestamptz NOT NULL DEFAULT now(),
  "expires_at"  timestamptz NOT NULL,
  CONSTRAINT "agent_transcripts_expiry_ck" CHECK ("expires_at" > "stored_at")
);

CREATE INDEX IF NOT EXISTS "agent_transcripts_expires_idx" ON "agents"."agent_transcripts" ("expires_at");

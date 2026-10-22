-- Joint restore runs (OPS-ledger-desk-05): one row per run, one append-only row per step, and an outbox so a step and the
-- event that announces it commit together.
CREATE TABLE ops.restore_runs (
 restore_no text PRIMARY KEY CHECK(length(restore_no) BETWEEN 1 AND 128),
 idempotency_key text NOT NULL UNIQUE,
 fingerprint text NOT NULL,
 cut_off timestamptz NOT NULL,
 started_by text NOT NULL,
 started_at timestamptz NOT NULL
);
CREATE TABLE ops.restore_steps (
 restore_no text NOT NULL REFERENCES ops.restore_runs(restore_no),
 step text NOT NULL CHECK(step IN ('restore_clean','validate','preview','finalize')),
 idempotency_key text NOT NULL UNIQUE,
 fingerprint text NOT NULL,
 actor text NOT NULL,
 approver_id text,
 detail jsonb NOT NULL,
 at timestamptz NOT NULL,
 PRIMARY KEY (restore_no, step)
);
CREATE FUNCTION ops.restore_steps_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.restore_step_immutable';
END $$;
CREATE TRIGGER restore_steps_append_only BEFORE UPDATE OR DELETE ON ops.restore_steps FOR EACH ROW EXECUTE FUNCTION ops.restore_steps_append_only();
CREATE TABLE ops.restore_outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event text NOT NULL CHECK(event IN ('coreOpsRestoreStarted','coreOpsRestoreCompleted','coreOpsRestoreFailed')),
 idempotency_key text NOT NULL UNIQUE,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 published_at timestamptz
);

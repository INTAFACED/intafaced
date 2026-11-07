-- svc-ops · staff incidents (OPS-oncall-02, J-ops-console-19 #10)
-- Reversal: 20261107083000_incidents.down.sql
--
-- An incident, who takes part, its tasks and its timeline. Nothing is seeded: with no incident every list and metric is
-- empty. The number comes from a sequence, never a clock. Each change stores the console's request key, so a lost reply is
-- read back, never applied twice. The timeline is append-only (the trigger function comes from
-- 20261024100000_console_announcements).
CREATE TABLE ops.incidents (
 id uuid PRIMARY KEY,
 number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
 module text CHECK (char_length(module) BETWEEN 1 AND 40),
 severity text NOT NULL CHECK (severity IN ('pending', 'critical', 'major', 'minor')),
 status text NOT NULL CHECK (status IN ('active', 'resolved')),
 private boolean NOT NULL,
 declared_by text NOT NULL,
 declare_key text NOT NULL UNIQUE,
 started_at timestamptz NOT NULL,
 ended_at timestamptz,
 CHECK ((status = 'resolved') = (ended_at IS NOT NULL)),
 CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX incidents_module_status ON ops.incidents (module, status);
CREATE TABLE ops.incident_participants (
 incident_id uuid NOT NULL REFERENCES ops.incidents (id),
 user_id text NOT NULL,
 added_by text NOT NULL,
 added_at timestamptz NOT NULL,
 PRIMARY KEY (incident_id, user_id)
);
CREATE TABLE ops.incident_tasks (
 id uuid PRIMARY KEY,
 incident_id uuid NOT NULL REFERENCES ops.incidents (id),
 title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
 assignee_id text NOT NULL,
 status text NOT NULL CHECK (status IN ('open', 'done')),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE TABLE ops.incident_timeline (
 id uuid PRIMARY KEY,
 incident_id uuid NOT NULL REFERENCES ops.incidents (id),
 kind text NOT NULL CHECK (kind IN ('declared', 'note', 'participant', 'task', 'resolved')),
 body text NOT NULL CHECK (char_length(body) <= 2000),
 actor_id text NOT NULL,
 at timestamptz NOT NULL,
 request_key text NOT NULL,
 request_hash text NOT NULL,
 UNIQUE (incident_id, request_key)
);
CREATE TRIGGER incident_timeline_append_only BEFORE UPDATE OR DELETE ON ops.incident_timeline FOR EACH ROW EXECUTE FUNCTION ops.console_log_append_only();

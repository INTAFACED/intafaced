-- svc-ops · founder console service records per module (OPS-service-health-01)
-- Reversal: 20261024110000_service_records.down.sql
--
-- What founders set by hand for one module's service page: the team that owns it, the modules it depends on, and its
-- runbook (a path inside docs/runbooks/, never an outside link). Nothing is seeded: a module with no row reads as
-- "owner not set". Each save is checked against the revision the founder read, and logged before and after in an
-- append-only log (the trigger function comes from 20261024100000_console_announcements).
CREATE TABLE ops.service_records (
 module text PRIMARY KEY CHECK (char_length(module) BETWEEN 1 AND 40),
 owner_team text CHECK (char_length(owner_team) BETWEEN 1 AND 80),
 dependencies text[] NOT NULL DEFAULT '{}',
 runbook text CHECK (
   char_length(runbook) <= 200
   AND position('..' IN runbook) = 0
   AND runbook ~ '^docs/runbooks/([A-Za-z0-9][A-Za-z0-9._-]*/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$'
 ),
 revision integer NOT NULL CHECK (revision >= 1),
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL
);
CREATE TABLE ops.service_record_log (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 module text NOT NULL,
 before jsonb NOT NULL,
 after jsonb NOT NULL,
 actor_id text NOT NULL,
 logged_at timestamptz NOT NULL
);
CREATE TRIGGER service_record_log_append_only BEFORE UPDATE OR DELETE ON ops.service_record_log FOR EACH ROW EXECUTE FUNCTION ops.console_log_append_only();

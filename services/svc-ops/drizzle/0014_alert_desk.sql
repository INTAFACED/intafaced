-- OPS-alerts-03: pipeline heartbeats, separate test beats, message templates (not delivery) and the alert quality policy.
-- Heartbeats, test beats and version rows are append-only. A current template or policy row updates only in the same transaction as its version.
-- alert_heartbeats is the evaluator's pipeline beat only. A manual test beat goes in alert_test_beats and is not read as the pipeline.
CREATE TABLE ops.alert_heartbeats (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 recorded_at timestamptz NOT NULL
);
CREATE FUNCTION ops.alert_heartbeats_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_heartbeat_immutable';
END $$;
CREATE TRIGGER alert_heartbeats_append_only BEFORE UPDATE OR DELETE ON ops.alert_heartbeats FOR EACH ROW EXECUTE FUNCTION ops.alert_heartbeats_append_only();

CREATE TABLE ops.alert_test_beats (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 recorded_at timestamptz NOT NULL
);
CREATE FUNCTION ops.alert_test_beats_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_test_beat_immutable';
END $$;
CREATE TRIGGER alert_test_beats_append_only BEFORE UPDATE OR DELETE ON ops.alert_test_beats FOR EACH ROW EXECUTE FUNCTION ops.alert_test_beats_append_only();

CREATE TABLE ops.alert_templates (
 name text PRIMARY KEY CHECK(name ~ '^[a-z][a-z0-9_-]{0,62}$'),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 500),
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 4000),
 variables jsonb NOT NULL CHECK(jsonb_typeof(variables) = 'array'),
 version integer NOT NULL CHECK(version >= 1),
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 updated_at timestamptz NOT NULL
);
CREATE TABLE ops.alert_template_versions (
 name text NOT NULL REFERENCES ops.alert_templates(name),
 version integer NOT NULL CHECK(version >= 1),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 500),
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 4000),
 variables jsonb NOT NULL CHECK(jsonb_typeof(variables) = 'array'),
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 at timestamptz NOT NULL,
 PRIMARY KEY (name, version)
);
CREATE FUNCTION ops.alert_template_versions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_template_version_immutable';
END $$;
CREATE TRIGGER alert_template_versions_append_only BEFORE UPDATE OR DELETE ON ops.alert_template_versions FOR EACH ROW EXECUTE FUNCTION ops.alert_template_versions_append_only();

CREATE TABLE ops.alert_quality_policy (
 id integer PRIMARY KEY CHECK(id = 1),
 requirements jsonb NOT NULL,
 version integer NOT NULL CHECK(version >= 1),
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 updated_at timestamptz NOT NULL
);
CREATE TABLE ops.alert_quality_policy_versions (
 version integer PRIMARY KEY CHECK(version >= 1),
 requirements jsonb NOT NULL,
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 at timestamptz NOT NULL
);
CREATE FUNCTION ops.alert_quality_versions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_quality_version_immutable';
END $$;
CREATE TRIGGER alert_quality_versions_append_only BEFORE UPDATE OR DELETE ON ops.alert_quality_policy_versions FOR EACH ROW EXECUTE FUNCTION ops.alert_quality_versions_append_only();

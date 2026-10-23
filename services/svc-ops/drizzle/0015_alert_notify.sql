-- OPS-alerts-02: routing tree, contact points, silences, channel attempts and the policy event.
-- Version rows, silences, attempts and the audit are append-only. A current route or contact updates only with its version.
ALTER TABLE ops.alert_outbox DROP CONSTRAINT IF EXISTS alert_outbox_event_check;
ALTER TABLE ops.alert_outbox ADD CONSTRAINT alert_outbox_event_check
  CHECK (event IN ('coreOpsAlertRuleUpdated','coreOpsAlertOpened','coreOpsAlertResolved','coreOpsAlertPolicyUpdated'));

CREATE TABLE ops.alert_route_policy (
 id integer PRIMARY KEY CHECK (id = 1),
 body jsonb NOT NULL,
 version integer NOT NULL CHECK (version >= 1),
 actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
 updated_at timestamptz NOT NULL
);
CREATE TABLE ops.alert_route_versions (
 version integer PRIMARY KEY CHECK (version >= 1),
 body jsonb NOT NULL,
 actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
 idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 at timestamptz NOT NULL
);
CREATE FUNCTION ops.alert_route_versions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_route_version_immutable';
END $$;
CREATE TRIGGER alert_route_versions_append_only BEFORE UPDATE OR DELETE ON ops.alert_route_versions FOR EACH ROW EXECUTE FUNCTION ops.alert_route_versions_append_only();

CREATE TABLE ops.alert_contacts (
 contact_id text PRIMARY KEY CHECK (contact_id ~ '^[a-z][a-z0-9_-]{0,62}$'),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 integrations jsonb NOT NULL,
 version integer NOT NULL CHECK (version >= 1),
 retired_at timestamptz,
 actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
 updated_at timestamptz NOT NULL
);
CREATE TABLE ops.alert_contact_versions (
 contact_id text NOT NULL,
 version integer NOT NULL CHECK (version >= 1),
 snapshot jsonb NOT NULL,
 actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
 idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 at timestamptz NOT NULL,
 PRIMARY KEY (contact_id, version)
);
CREATE FUNCTION ops.alert_contact_versions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_contact_version_immutable';
END $$;
CREATE TRIGGER alert_contact_versions_append_only BEFORE UPDATE OR DELETE ON ops.alert_contact_versions FOR EACH ROW EXECUTE FUNCTION ops.alert_contact_versions_append_only();

CREATE TABLE ops.alert_silences (
 silence_id text PRIMARY KEY CHECK (silence_id ~ '^[a-z][a-z0-9_-]{0,62}$'),
 matchers jsonb NOT NULL,
 ends_at timestamptz NOT NULL,
 actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
 idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL
);
CREATE FUNCTION ops.alert_silences_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_silence_immutable';
END $$;
CREATE TRIGGER alert_silences_append_only BEFORE UPDATE OR DELETE ON ops.alert_silences FOR EACH ROW EXECUTE FUNCTION ops.alert_silences_append_only();

CREATE TABLE ops.alert_notifications (
 notification_id text PRIMARY KEY CHECK (notification_id ~ '^ops:notify:[a-z][a-z0-9_-]{0,62}:[1-9][0-9]*$'),
 contact_id text NOT NULL,
 integration_id text NOT NULL,
 ordinal integer NOT NULL CHECK (ordinal >= 1),
 idempotency_key text UNIQUE CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 200),
 UNIQUE (contact_id, integration_id, ordinal)
);
CREATE TABLE ops.alert_channel_attempts (
 notification_id text NOT NULL REFERENCES ops.alert_notifications (notification_id),
 attempt integer NOT NULL CHECK (attempt >= 1),
 idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 code text,
 actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
 at timestamptz NOT NULL,
 PRIMARY KEY (notification_id, attempt)
);
CREATE INDEX alert_channel_attempts_key_idx ON ops.alert_channel_attempts (idempotency_key, attempt);
CREATE TABLE ops.alert_send_claims (
 idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
 attempt integer NOT NULL CHECK (attempt >= 1),
 notification_id text NOT NULL,
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 claimed_at timestamptz NOT NULL,
 PRIMARY KEY (idempotency_key, attempt)
);
CREATE FUNCTION ops.alert_send_claims_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_send_claim_immutable';
END $$;
CREATE TRIGGER alert_send_claims_append_only BEFORE UPDATE OR DELETE ON ops.alert_send_claims FOR EACH ROW EXECUTE FUNCTION ops.alert_send_claims_append_only();
CREATE FUNCTION ops.alert_channel_attempts_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_channel_attempt_immutable';
END $$;
CREATE TRIGGER alert_channel_attempts_append_only BEFORE UPDATE OR DELETE ON ops.alert_channel_attempts FOR EACH ROW EXECUTE FUNCTION ops.alert_channel_attempts_append_only();

CREATE TABLE ops.alert_notify_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 action text NOT NULL CHECK (action IN ('route.saved','contact.saved','contact.retired','silence.created','channel.tested','grouping.refused','grouping.suppressed','grouping.sent')),
 subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
 before jsonb,
 after jsonb,
 actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
 idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 at timestamptz NOT NULL
);
CREATE FUNCTION ops.alert_notify_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_notify_audit_immutable';
END $$;
CREATE TRIGGER alert_notify_audit_append_only BEFORE UPDATE OR DELETE ON ops.alert_notify_audit FOR EACH ROW EXECUTE FUNCTION ops.alert_notify_audit_append_only();

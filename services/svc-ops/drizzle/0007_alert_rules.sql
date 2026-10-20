-- Platform alert rules (OPS-alerts-01). The current rule is one row; every save keeps an append-only version row.
CREATE TABLE ops.alert_rules (
 id uuid PRIMARY KEY,
 name text NOT NULL,
 folder text NOT NULL,
 rule_group text NOT NULL,
 signal text NOT NULL,
 operator text NOT NULL CHECK(operator IN ('gt','gte','lt','lte','eq')),
 threshold text NOT NULL CHECK(threshold ~ '^-?[0-9]+(\.[0-9]{1,18})?$'),
 interval_seconds integer NOT NULL CHECK(interval_seconds >= 1),
 pending_seconds integer NOT NULL CHECK(pending_seconds >= 0),
 labels jsonb NOT NULL,
 labels_hash text CHECK(labels_hash ~ '^[a-f0-9]{64}$'),
 annotations jsonb NOT NULL,
 no_data text NOT NULL CHECK(no_data IN ('alerting','keep_last','normal')),
 exec_error text NOT NULL CHECK(exec_error IN ('alerting','keep_last','normal')),
 paused boolean NOT NULL,
 version integer NOT NULL CHECK(version >= 1),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 retired_at timestamptz
);
-- Two live rules cannot carry the same non-empty label set: their instances would be routed as one.
CREATE UNIQUE INDEX alert_rules_labels_live_idx ON ops.alert_rules (labels_hash) WHERE labels_hash IS NOT NULL AND retired_at IS NULL;
CREATE INDEX alert_rules_list_idx ON ops.alert_rules (folder, rule_group, name, id);
CREATE TABLE ops.alert_rule_versions (
 rule_id uuid NOT NULL REFERENCES ops.alert_rules(id),
 version integer NOT NULL CHECK(version >= 1),
 change text NOT NULL CHECK(change IN ('created','updated','paused','resumed','retired','restored')),
 snapshot jsonb NOT NULL,
 actor text NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 idempotency_key text NOT NULL CONSTRAINT alert_rule_versions_idempotency_key UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 at timestamptz NOT NULL,
 PRIMARY KEY (rule_id, version)
);
CREATE FUNCTION ops.alert_rule_versions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_rule_version_immutable';
END $$;
CREATE TRIGGER alert_rule_versions_append_only BEFORE UPDATE OR DELETE ON ops.alert_rule_versions FOR EACH ROW EXECUTE FUNCTION ops.alert_rule_versions_append_only();

-- Alert state (OPS-alerts-01): one row per alert instance, an append-only state history, and an outbox so a transition and the event
-- that announces it commit together.
CREATE TABLE ops.alert_instances (
 rule_id uuid NOT NULL REFERENCES ops.alert_rules(id),
 instance text NOT NULL CHECK(instance ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('normal','pending','firing')),
 health text NOT NULL CHECK(health IN ('ok','error','no_data')),
 -- Episode counter: grows by one each time the instance opens, so a restarted evaluator derives the same event key.
 epoch integer NOT NULL CHECK(epoch >= 0),
 pending_since timestamptz,
 firing_since timestamptz,
 last_evaluated_at timestamptz NOT NULL,
 last_value text,
 last_code text,
 kept boolean NOT NULL DEFAULT false,
 PRIMARY KEY (rule_id, instance)
);
CREATE TABLE ops.alert_state_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 rule_id uuid NOT NULL REFERENCES ops.alert_rules(id),
 instance text NOT NULL,
 epoch integer NOT NULL,
 at timestamptz NOT NULL,
 from_state text NOT NULL,
 to_state text NOT NULL,
 health text NOT NULL,
 value text,
 code text
);
CREATE INDEX alert_state_history_rule_idx ON ops.alert_state_history (rule_id, id DESC);
CREATE INDEX alert_state_history_at_idx ON ops.alert_state_history (at DESC, id DESC);
CREATE TABLE ops.alert_outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event text NOT NULL CHECK(event IN ('coreOpsAlertRuleUpdated','coreOpsAlertOpened','coreOpsAlertResolved')),
 idempotency_key text NOT NULL UNIQUE,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 published_at timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 last_error text
);
CREATE INDEX alert_outbox_pending_idx ON ops.alert_outbox (id) WHERE published_at IS NULL;
CREATE FUNCTION ops.alert_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.alert_history_immutable';
END $$;
CREATE TRIGGER alert_state_history_append_only BEFORE UPDATE OR DELETE ON ops.alert_state_history FOR EACH ROW EXECUTE FUNCTION ops.alert_history_append_only();

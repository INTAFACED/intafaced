-- svc-ops · the capital monitor (RC-ops-console-06, J-ops-console-24 #1)
-- Reversal: 20261108225501_capital_monitor.down.sql
--
-- Buffer thresholds: one minimum per asset, set or cleared by one founder with a second founder's approval. Every change is
-- a new version and no version is ever edited, so the log is the audit (who asked, who approved, why, before and after).
-- A cleared threshold is a version with no minimum: the asset is not monitored again.
--
-- Breach alerts: one per asset and UTC day, keyed `capital-breach:{asset}:{day}`, naming the contact it was escalated to.
-- Never edited. Nothing here holds or moves a balance.
CREATE TABLE ops.capital_thresholds (
 asset_id text NOT NULL CHECK (asset_id ~ '^[A-Z0-9]{2,16}$'),
 version integer NOT NULL CHECK (version >= 1),
 minimum numeric(38,18) CHECK (minimum >= 0),
 contact text NOT NULL CHECK (length(contact) <= 200),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
 idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 approval_id text NOT NULL,
 set_by text NOT NULL,
 approved_by text NOT NULL,
 set_at timestamptz NOT NULL,
 PRIMARY KEY (asset_id, version),
 CHECK ((minimum IS NULL) = (contact = ''))
);
CREATE TABLE ops.capital_breach_alerts (
 key text PRIMARY KEY CHECK (key ~ '^capital-breach:[A-Z0-9]{2,16}:\d{4}-\d{2}-\d{2}$'),
 asset_id text NOT NULL,
 period text NOT NULL CHECK (period ~ '^\d{4}-\d{2}-\d{2}$'),
 buffer numeric(38,18) NOT NULL CHECK (buffer >= 0),
 minimum numeric(38,18) NOT NULL CHECK (minimum >= 0),
 escalated_to text NOT NULL CHECK (length(escalated_to) BETWEEN 1 AND 200),
 threshold_version integer NOT NULL,
 opened_at timestamptz NOT NULL
);
CREATE INDEX capital_breach_alerts_opened_idx ON ops.capital_breach_alerts (opened_at DESC);
CREATE FUNCTION ops.capital_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.capital_record_immutable';
END $$;
CREATE TRIGGER capital_thresholds_append_only BEFORE UPDATE OR DELETE ON ops.capital_thresholds FOR EACH ROW EXECUTE FUNCTION ops.capital_append_only();
CREATE TRIGGER capital_breach_alerts_append_only BEFORE UPDATE OR DELETE ON ops.capital_breach_alerts FOR EACH ROW EXECUTE FUNCTION ops.capital_append_only();

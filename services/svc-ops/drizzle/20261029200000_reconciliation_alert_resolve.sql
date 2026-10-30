-- svc-ops · reconciliation alerts: resolve, accept, reopen, platform alerts and the event outbox (OPS-reconciliation-04)
-- Reversal: 20261029200000_reconciliation_alert_resolve.down.sql
--
-- An alert now has a cause: `fail` (the books disagree, raised to finance) or `error` (the run could not finish, raised to
-- the platform team), and the cause is part of the fingerprint. An operator resolves a FAIL as fixed by linking corrective
-- ledger transactions; a later passing run of the same control and period resolves any live alert automatically; a repeat
-- failure reopens a resolved alert. Two founders accept a discrepancy, which freezes its evidence at the hash both signed;
-- an accepted alert never changes again. Every transition writes one outbox row in the same transaction, which the relay
-- publishes. A `ledger.reconciliation_run.failed` event received is one platform incident, however often it arrives.
-- Nothing here holds or moves a balance.
ALTER TABLE ops.reconciliation_alerts
 ADD COLUMN cause text NOT NULL DEFAULT 'fail' CHECK (cause IN ('fail', 'error')),
 ADD COLUMN error_code text,
 ADD COLUMN error_phase text,
 ADD COLUMN resolution text CHECK (resolution IN ('fixed', 'auto')),
 ADD COLUMN resolved_by text,
 ADD COLUMN resolved_at timestamptz,
 ADD COLUMN corrective_tx_ids uuid[] NOT NULL DEFAULT '{}',
 ADD COLUMN passing_run_id uuid,
 ADD COLUMN resolve_note text,
 ADD COLUMN accepted_requested_by text,
 ADD COLUMN accepted_approved_by text,
 ADD COLUMN accepted_at timestamptz,
 ADD COLUMN accepted_note text,
 ADD COLUMN accepted_evidence_hash text CHECK (accepted_evidence_hash ~ '^[0-9a-f]{64}$'),
 ADD COLUMN accepted_approval_id text UNIQUE;

ALTER TABLE ops.reconciliation_alerts
 ADD CONSTRAINT reconciliation_alerts_cause_shape_check CHECK (
  (cause = 'error') = (error_code IS NOT NULL) AND (error_code IS NOT NULL OR error_phase IS NULL)
  AND (cause = 'fail' OR asset_id IS NULL)
 ),
 ADD CONSTRAINT reconciliation_alerts_resolved_check CHECK (
  (state = 'resolved') = (resolution IS NOT NULL)
  AND (resolution IS NULL) = (resolved_by IS NULL) AND (resolution IS NULL) = (resolved_at IS NULL)
  AND (resolution IS NOT NULL OR (cardinality(corrective_tx_ids) = 0 AND passing_run_id IS NULL AND resolve_note IS NULL))
  AND (resolution IS DISTINCT FROM 'fixed'
       OR (cause = 'fail' AND cardinality(corrective_tx_ids) BETWEEN 1 AND 20 AND passing_run_id IS NULL AND resolved_by <> 'auto'))
  AND (resolution IS DISTINCT FROM 'auto'
       OR (cardinality(corrective_tx_ids) = 0 AND passing_run_id IS NOT NULL AND resolved_by = 'auto' AND resolve_note IS NULL))
 ),
 ADD CONSTRAINT reconciliation_alerts_accepted_check CHECK (
  (state = 'accepted') = (accepted_at IS NOT NULL)
  AND (accepted_at IS NULL) = (accepted_requested_by IS NULL) AND (accepted_at IS NULL) = (accepted_approved_by IS NULL)
  AND (accepted_at IS NULL) = (accepted_note IS NULL) AND (accepted_at IS NULL) = (accepted_evidence_hash IS NULL)
  AND (accepted_at IS NULL) = (accepted_approval_id IS NULL)
  AND (accepted_at IS NULL OR (cause = 'fail' AND btrim(accepted_note) <> ''
       AND lower(btrim(accepted_requested_by)) <> lower(btrim(accepted_approved_by))))
 );

DROP INDEX ops.reconciliation_alerts_live_fingerprint_idx;
CREATE UNIQUE INDEX reconciliation_alerts_live_fingerprint_idx
 ON ops.reconciliation_alerts (kind, control_id, cause, coalesce(asset_id, ''), period_start)
 WHERE state IN ('open', 'acknowledged');
-- The latest alert of a fingerprint, whatever its state: a repeat failure looks here for one to reopen or a frozen one.
CREATE INDEX reconciliation_alerts_fingerprint_idx
 ON ops.reconciliation_alerts (control_id, cause, coalesce(asset_id, ''), period_start, first_seen DESC);

CREATE OR REPLACE FUNCTION ops.reconciliation_alerts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'ops.reconciliation_alerts rows are never deleted' USING ERRCODE = 'restrict_violation';
 END IF;
 IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.control_id <> OLD.control_id
    OR NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.period_start <> OLD.period_start OR NEW.cause <> OLD.cause
    OR NEW.first_seen <> OLD.first_seen OR NEW.occurrences < OLD.occurrences OR NEW.version <> OLD.version + 1 THEN
  RAISE EXCEPTION 'a reconciliation alert keeps its fingerprint and only counts up' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.state = 'accepted' THEN
  RAISE EXCEPTION 'an accepted reconciliation alert is frozen' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.state = 'resolved' AND NEW.state NOT IN ('resolved', 'open') THEN
  RAISE EXCEPTION 'a resolved reconciliation alert only reopens' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.state = 'resolved' AND NEW.state = 'resolved' AND (NEW.resolution IS DISTINCT FROM OLD.resolution
    OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
    OR NEW.corrective_tx_ids IS DISTINCT FROM OLD.corrective_tx_ids OR NEW.passing_run_id IS DISTINCT FROM OLD.passing_run_id
    OR NEW.resolve_note IS DISTINCT FROM OLD.resolve_note) THEN
  RAISE EXCEPTION 'a resolution is never rewritten' USING ERRCODE = 'restrict_violation';
 END IF;
 -- An acknowledgement is never rewritten; only a reopen (resolved to open) clears it, and the timeline keeps it.
 IF OLD.ack_by IS NOT NULL AND (NEW.ack_by IS DISTINCT FROM OLD.ack_by OR NEW.ack_at IS DISTINCT FROM OLD.ack_at
    OR NEW.ack_note IS DISTINCT FROM OLD.ack_note)
    AND NOT (OLD.state = 'resolved' AND NEW.state = 'open' AND NEW.ack_by IS NULL) THEN
  RAISE EXCEPTION 'an acknowledgement is never rewritten' USING ERRCODE = 'restrict_violation';
 END IF;
 RETURN NEW;
END;
$$;

ALTER TABLE ops.reconciliation_alert_timeline
 ADD COLUMN tx_ids uuid[] NOT NULL DEFAULT '{}',
 DROP CONSTRAINT reconciliation_alert_timeline_kind_check,
 DROP CONSTRAINT reconciliation_alert_timeline_check;
ALTER TABLE ops.reconciliation_alert_timeline
 ADD CONSTRAINT reconciliation_alert_timeline_kind_check CHECK (
  kind IN ('opened', 'repeated', 'acknowledged', 'snoozed', 'unsnoozed', 'resolved', 'accepted', 'reopened')
 ),
 ADD CONSTRAINT reconciliation_alert_timeline_check CHECK (
  (kind IN ('opened', 'repeated', 'reopened')) = (notice IS NOT NULL)
  AND (kind NOT IN ('opened', 'repeated', 'reopened') OR run_id IS NOT NULL)
  AND (kind = 'resolved' OR cardinality(tx_ids) = 0)
 );

-- One row per transition, written in the transition's transaction; the relay publishes it at least once by its key.
CREATE TABLE ops.reconciliation_alert_events (
 id bigserial PRIMARY KEY,
 alert_id uuid NOT NULL REFERENCES ops.reconciliation_alerts (id),
 sequence integer NOT NULL CHECK (sequence >= 1),
 name text NOT NULL CHECK (name IN ('coreOpsReconciliationAlertOpened', 'coreOpsReconciliationAlertUpdated',
  'coreOpsReconciliationAlertResolved', 'coreOpsReconciliationAlertAccepted')),
 payload jsonb NOT NULL,
 idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key = 'ops:reconciliation-alert:' || alert_id || ':' || sequence),
 created_at timestamptz NOT NULL,
 published_at timestamptz,
 UNIQUE (alert_id, sequence)
);
CREATE INDEX reconciliation_alert_events_due_idx ON ops.reconciliation_alert_events (id) WHERE published_at IS NULL;

CREATE FUNCTION ops.reconciliation_alert_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'ops.reconciliation_alert_events rows are never deleted' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.published_at IS NOT NULL OR NEW.published_at IS NULL OR NEW.id <> OLD.id OR NEW.alert_id <> OLD.alert_id
    OR NEW.sequence <> OLD.sequence OR NEW.name <> OLD.name OR NEW.payload <> OLD.payload
    OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
  RAISE EXCEPTION 'an alert event is never edited; it is only marked published once' USING ERRCODE = 'restrict_violation';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER reconciliation_alert_events_guard BEFORE UPDATE OR DELETE ON ops.reconciliation_alert_events
 FOR EACH ROW EXECUTE FUNCTION ops.reconciliation_alert_events_guard();

-- A ledger reconciliation run that could not finish, as received from the bus. Append-only; the event key is the PK.
CREATE TABLE ops.reconciliation_platform_incidents (
 event_key text PRIMARY KEY CHECK (btrim(event_key) <> ''),
 error_code text NOT NULL CHECK (btrim(error_code) <> ''),
 phase text NOT NULL CHECK (btrim(phase) <> ''),
 consecutive_incomplete integer NOT NULL CHECK (consecutive_incomplete >= 1),
 ledger_run_id text,
 occurred_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL
);
CREATE INDEX reconciliation_platform_incidents_received_idx ON ops.reconciliation_platform_incidents (received_at DESC, event_key);

CREATE FUNCTION ops.reconciliation_platform_incidents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.reconciliation_platform_incidents is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER reconciliation_platform_incidents_guard BEFORE UPDATE OR DELETE ON ops.reconciliation_platform_incidents
 FOR EACH ROW EXECUTE FUNCTION ops.reconciliation_platform_incidents_guard();

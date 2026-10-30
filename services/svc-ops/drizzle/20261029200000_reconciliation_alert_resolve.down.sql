-- svc-ops · reverse 20261029200000_reconciliation_alert_resolve.sql
-- A platform (error) alert and a fail alert of the same control, asset and period can both be live after the up; the old
-- fingerprint index then refuses to build and this reversal stops, so resolve one of them first.
DROP TABLE IF EXISTS ops.reconciliation_platform_incidents;
DROP FUNCTION IF EXISTS ops.reconciliation_platform_incidents_guard();
DROP TABLE IF EXISTS ops.reconciliation_alert_events;
DROP FUNCTION IF EXISTS ops.reconciliation_alert_events_guard();

ALTER TABLE ops.reconciliation_alert_timeline
 DROP CONSTRAINT reconciliation_alert_timeline_check,
 DROP CONSTRAINT reconciliation_alert_timeline_kind_check;
ALTER TABLE ops.reconciliation_alert_timeline
 ADD CONSTRAINT reconciliation_alert_timeline_kind_check
  CHECK (kind IN ('opened', 'repeated', 'acknowledged', 'snoozed', 'unsnoozed')) NOT VALID,
 ADD CONSTRAINT reconciliation_alert_timeline_check
  CHECK ((kind IN ('opened', 'repeated')) = (run_id IS NOT NULL AND notice IS NOT NULL)) NOT VALID,
 DROP COLUMN tx_ids;

CREATE OR REPLACE FUNCTION ops.reconciliation_alerts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'ops.reconciliation_alerts rows are never deleted' USING ERRCODE = 'restrict_violation';
 END IF;
 IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.control_id <> OLD.control_id
    OR NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.period_start <> OLD.period_start
    OR NEW.first_seen <> OLD.first_seen OR NEW.occurrences < OLD.occurrences OR NEW.version <> OLD.version + 1 THEN
  RAISE EXCEPTION 'a reconciliation alert keeps its fingerprint and only counts up' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.ack_by IS NOT NULL AND (NEW.ack_by IS DISTINCT FROM OLD.ack_by OR NEW.ack_at IS DISTINCT FROM OLD.ack_at
    OR NEW.ack_note IS DISTINCT FROM OLD.ack_note) THEN
  RAISE EXCEPTION 'an acknowledgement is never rewritten' USING ERRCODE = 'restrict_violation';
 END IF;
 RETURN NEW;
END;
$$;

DROP INDEX IF EXISTS ops.reconciliation_alerts_fingerprint_idx;
DROP INDEX ops.reconciliation_alerts_live_fingerprint_idx;
CREATE UNIQUE INDEX reconciliation_alerts_live_fingerprint_idx
 ON ops.reconciliation_alerts (kind, control_id, coalesce(asset_id, ''), period_start)
 WHERE state IN ('open', 'acknowledged');

ALTER TABLE ops.reconciliation_alerts
 DROP CONSTRAINT reconciliation_alerts_accepted_check,
 DROP CONSTRAINT reconciliation_alerts_resolved_check,
 DROP CONSTRAINT reconciliation_alerts_cause_shape_check,
 DROP COLUMN accepted_approval_id,
 DROP COLUMN accepted_evidence_hash,
 DROP COLUMN accepted_note,
 DROP COLUMN accepted_at,
 DROP COLUMN accepted_approved_by,
 DROP COLUMN accepted_requested_by,
 DROP COLUMN resolve_note,
 DROP COLUMN passing_run_id,
 DROP COLUMN corrective_tx_ids,
 DROP COLUMN resolved_at,
 DROP COLUMN resolved_by,
 DROP COLUMN resolution,
 DROP COLUMN error_phase,
 DROP COLUMN error_code,
 DROP COLUMN cause;

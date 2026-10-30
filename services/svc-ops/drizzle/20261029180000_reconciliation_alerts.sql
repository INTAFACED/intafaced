-- svc-ops · reconciliation alerts (OPS-reconciliation-03)
-- Reversal: 20261029180000_reconciliation_alerts.down.sql
--
-- svc-ops reads every settled evaluation from svc-ledger's `reconciliationEvaluations` door and keeps one alert per
-- control, failing asset and period while it is open or acknowledged. A failure with no asset (a broken chain) keys on a
-- blank asset. The timeline is append-only. A snooze is never edited: a new one replaces it and the old row only gains
-- `expired_at`. A period is green only when it was evaluated and no alert in it is open or acknowledged. Nothing here
-- holds or moves a balance.
CREATE TABLE ops.reconciliation_alerts (
 id uuid PRIMARY KEY,
 kind text NOT NULL DEFAULT 'reconciliation' CHECK (kind IN ('reconciliation')),
 state text NOT NULL CHECK (state IN ('open', 'acknowledged', 'resolved', 'accepted')),
 control_id uuid NOT NULL,
 asset_id text,
 period_start timestamptz NOT NULL,
 period_end timestamptz NOT NULL,
 severity jsonb NOT NULL,
 occurrences integer NOT NULL CHECK (occurrences >= 1),
 first_seen timestamptz NOT NULL,
 last_seen timestamptz NOT NULL,
 last_run_id uuid NOT NULL,
 evidence jsonb NOT NULL,
 ack_by text,
 ack_at timestamptz,
 ack_note text,
 notices_sent integer NOT NULL CHECK (notices_sent >= 0),
 last_notice_at timestamptz,
 version integer NOT NULL CHECK (version >= 1),
 CHECK ((state = 'open') = (ack_by IS NULL) OR state IN ('resolved', 'accepted')),
 CHECK ((ack_by IS NULL) = (ack_at IS NULL) AND (ack_by IS NULL) = (ack_note IS NULL))
);

CREATE UNIQUE INDEX reconciliation_alerts_live_fingerprint_idx
 ON ops.reconciliation_alerts (kind, control_id, coalesce(asset_id, ''), period_start)
 WHERE state IN ('open', 'acknowledged');
CREATE INDEX reconciliation_alerts_seen_idx ON ops.reconciliation_alerts (last_seen DESC, id DESC);
CREATE INDEX reconciliation_alerts_period_idx ON ops.reconciliation_alerts (control_id, period_start);

CREATE TABLE ops.reconciliation_alert_snoozes (
 id uuid PRIMARY KEY,
 alert_id uuid NOT NULL REFERENCES ops.reconciliation_alerts (id),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
 snoozed_by text NOT NULL CHECK (btrim(snoozed_by) <> ''),
 reason text,
 expired_at timestamptz
);
CREATE INDEX reconciliation_alert_snoozes_alert_idx ON ops.reconciliation_alert_snoozes (alert_id, starts_at DESC);
CREATE UNIQUE INDEX reconciliation_alert_snoozes_live_idx ON ops.reconciliation_alert_snoozes (alert_id) WHERE expired_at IS NULL;

CREATE TABLE ops.reconciliation_alert_timeline (
 id bigserial PRIMARY KEY,
 alert_id uuid NOT NULL REFERENCES ops.reconciliation_alerts (id),
 at timestamptz NOT NULL,
 kind text NOT NULL CHECK (kind IN ('opened', 'repeated', 'acknowledged', 'snoozed', 'unsnoozed')),
 actor text NOT NULL CHECK (btrim(actor) <> ''),
 note text,
 run_id uuid,
 notice text CHECK (notice IN ('sent', 'not_due', 'repeat_unset', 'snoozed')),
 snooze_id uuid REFERENCES ops.reconciliation_alert_snoozes (id),
 idempotency_key text UNIQUE,
 CHECK ((kind IN ('opened', 'repeated')) = (run_id IS NOT NULL AND notice IS NOT NULL))
);
CREATE INDEX reconciliation_alert_timeline_alert_idx ON ops.reconciliation_alert_timeline (alert_id, id);

CREATE TABLE ops.reconciliation_ingested_runs (
 run_id uuid PRIMARY KEY,
 ingested_at timestamptz NOT NULL
);

CREATE TABLE ops.reconciliation_periods (
 control_id uuid NOT NULL,
 period_start timestamptz NOT NULL,
 period_end timestamptz NOT NULL,
 evaluations integer NOT NULL CHECK (evaluations >= 1),
 last_run_id uuid NOT NULL,
 last_status text NOT NULL CHECK (last_status IN ('PASS', 'FAIL', 'ERROR', 'UNSET')),
 PRIMARY KEY (control_id, period_start)
);

-- One row per source. The cursor is kept as the ledger wrote it (microseconds), never re-rounded.
CREATE TABLE ops.reconciliation_feed (
 source text PRIMARY KEY CHECK (source IN ('ledger.reconciliation_evaluations')),
 cursor_finished_at text,
 cursor_run_id uuid,
 last_ok_at timestamptz,
 error_message text,
 error_since timestamptz,
 CHECK ((cursor_finished_at IS NULL) = (cursor_run_id IS NULL))
);

CREATE FUNCTION ops.reconciliation_alert_timeline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.reconciliation_alert_timeline is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER reconciliation_alert_timeline_guard BEFORE UPDATE OR DELETE ON ops.reconciliation_alert_timeline
 FOR EACH ROW EXECUTE FUNCTION ops.reconciliation_alert_timeline_guard();

CREATE FUNCTION ops.reconciliation_alert_snoozes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'ops.reconciliation_alert_snoozes rows are never deleted' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.expired_at IS NOT NULL OR NEW.expired_at IS NULL OR NEW.id <> OLD.id OR NEW.alert_id <> OLD.alert_id
    OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at OR NEW.snoozed_by <> OLD.snoozed_by
    OR NEW.reason IS DISTINCT FROM OLD.reason THEN
  RAISE EXCEPTION 'a snooze is never edited; it only expires once' USING ERRCODE = 'restrict_violation';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER reconciliation_alert_snoozes_guard BEFORE UPDATE OR DELETE ON ops.reconciliation_alert_snoozes
 FOR EACH ROW EXECUTE FUNCTION ops.reconciliation_alert_snoozes_guard();

CREATE FUNCTION ops.reconciliation_alerts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER reconciliation_alerts_guard BEFORE UPDATE OR DELETE ON ops.reconciliation_alerts
 FOR EACH ROW EXECUTE FUNCTION ops.reconciliation_alerts_guard();

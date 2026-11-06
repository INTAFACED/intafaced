-- svc-ops · OPS-reconciliation-04: each reconciliation alert transition event as svc-ops received it back from the bus, the
-- delivery check on its own outbox. Append-only; the event's business key is the PK, so the same event delivered twice is
-- stored once.
CREATE TABLE ops.reconciliation_alert_receipts (
 event_key text PRIMARY KEY CHECK (btrim(event_key) <> ''),
 alert_id uuid NOT NULL,
 sequence integer NOT NULL CHECK (sequence >= 1),
 event text NOT NULL CHECK (event IN ('opened', 'updated', 'resolved', 'accepted')),
 transition text CHECK (transition IN ('acknowledged', 'snoozed', 'unsnoozed', 'reopened')),
 occurred_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL,
 CHECK ((event = 'updated') = (transition IS NOT NULL))
);
CREATE INDEX reconciliation_alert_receipts_alert_idx ON ops.reconciliation_alert_receipts (alert_id, sequence);

CREATE FUNCTION ops.reconciliation_alert_receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.reconciliation_alert_receipts is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER reconciliation_alert_receipts_guard BEFORE UPDATE OR DELETE ON ops.reconciliation_alert_receipts
 FOR EACH ROW EXECUTE FUNCTION ops.reconciliation_alert_receipts_guard();

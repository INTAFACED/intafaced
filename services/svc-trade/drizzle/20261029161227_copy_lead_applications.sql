-- trade.copy · lead applications and the lead criteria (CB-copy-12, CB-ops-01, J-copy-bots-otc-10)
-- Reversal: 20261029161227_copy_lead_applications.down.sql
--
-- A customer applies to lead; two founders decide. Approving needs a second founder's approval (identity's action
-- approval `trade.copy_lead_approve`, consumed once) and lists the applicant through the operator leader directory.
-- One open application per person. A status moves forward only. The criteria are owner values: a missing row is
-- unset and approving refuses `trade.copy_lead_criteria_unset`. No money moves here.

CREATE TABLE IF NOT EXISTS trade.copy_lead_applications (
  id uuid PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT copy_lead_applications_user_ck CHECK (length(btrim(user_id)) > 0),
  display_name text NOT NULL CONSTRAINT copy_lead_applications_name_ck CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'pending',
  approval_id text,
  proposed_by text,
  decided_by text,
  approver_id text,
  reason text,
  leader_ref text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  decided_at timestamptz,
  CONSTRAINT copy_lead_applications_status_ck CHECK (status IN ('pending', 'awaiting_second', 'approved', 'rejected')),
  CONSTRAINT copy_lead_applications_waiting_ck CHECK (status <> 'awaiting_second' OR (approval_id IS NOT NULL AND proposed_by IS NOT NULL)),
  CONSTRAINT copy_lead_applications_approved_ck CHECK (
    status <> 'approved'
    OR (approver_id IS NOT NULL AND leader_ref IS NOT NULL AND lower(btrim(approver_id)) <> lower(btrim(proposed_by)))
  ),
  CONSTRAINT copy_lead_applications_rejected_ck CHECK (status <> 'rejected' OR (reason IS NOT NULL AND length(btrim(reason)) >= 3))
);

-- One open application per person: a second submit answers the open one.
CREATE UNIQUE INDEX IF NOT EXISTS copy_lead_applications_open_idx
  ON trade.copy_lead_applications (user_id) WHERE status IN ('pending', 'awaiting_second');
CREATE UNIQUE INDEX IF NOT EXISTS copy_lead_applications_approval_idx
  ON trade.copy_lead_applications (approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS copy_lead_applications_queue_idx
  ON trade.copy_lead_applications (created_at, id) WHERE status IN ('pending', 'awaiting_second');
CREATE INDEX IF NOT EXISTS copy_lead_applications_user_idx ON trade.copy_lead_applications (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION trade.copy_lead_applications_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('awaiting_second', 'rejected'))
    OR (OLD.status = 'awaiting_second' AND NEW.status IN ('approved', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'trade.copy_lead_applications: % cannot become %.', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'trade.copy_lead_applications: a decided application is final.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS copy_lead_applications_forward_trg ON trade.copy_lead_applications;
CREATE TRIGGER copy_lead_applications_forward_trg
  BEFORE UPDATE ON trade.copy_lead_applications
  FOR EACH ROW EXECUTE FUNCTION trade.copy_lead_applications_forward();

-- The criteria an operator measures applicants against. Append-only: the newest row is in force.
CREATE TABLE IF NOT EXISTS trade.copy_lead_criteria (
  id uuid PRIMARY KEY,
  min_track_record_days integer NOT NULL CONSTRAINT copy_lead_criteria_days_ck CHECK (min_track_record_days BETWEEN 0 AND 3650),
  set_by text NOT NULL CONSTRAINT copy_lead_criteria_set_by_ck CHECK (length(btrim(set_by)) > 0),
  client_request_id text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS copy_lead_criteria_request_idx ON trade.copy_lead_criteria (client_request_id);
CREATE INDEX IF NOT EXISTS copy_lead_criteria_order_idx ON trade.copy_lead_criteria (created_at DESC, id DESC);

DROP TRIGGER IF EXISTS copy_lead_criteria_append_only ON trade.copy_lead_criteria;
CREATE TRIGGER copy_lead_criteria_append_only
  BEFORE UPDATE OR DELETE ON trade.copy_lead_criteria
  FOR EACH ROW EXECUTE FUNCTION trade.copy_leader_append_only();

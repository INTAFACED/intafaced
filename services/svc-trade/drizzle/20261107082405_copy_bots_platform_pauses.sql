-- trade.copy_bots · the copy and bots kill switch by lead, bot type or symbol (CB-ops-03, J-copy-bots-otc-12)
-- Reversal: 20261107082405_copy_bots_platform_pauses.down.sql
--
-- Two founders pause or resume one scope: a lead, a bot type, or a symbol. The first founder files identity's action
-- approval (`trade.copy_bots_pause` or `trade.copy_bots_resume`) and a request row waits here; a second founder approves
-- it there and confirms here, which consumes it once and applies the change with one operator audit row. A pause stops
-- new copy mirrors and new bot orders in its scope; it places, cancels and closes nothing, so existing positions keep
-- running. Nothing here holds or moves money.

CREATE TABLE IF NOT EXISTS trade.copy_bots_pause_requests (
  id uuid PRIMARY KEY,
  op text NOT NULL CONSTRAINT copy_bots_pause_requests_op_ck CHECK (op IN ('pause', 'resume')),
  scope_kind text NOT NULL CONSTRAINT copy_bots_pause_requests_kind_ck CHECK (scope_kind IN ('lead', 'bot_type', 'symbol')),
  scope_value text NOT NULL CONSTRAINT copy_bots_pause_requests_value_ck CHECK (length(btrim(scope_value)) BETWEEN 1 AND 80),
  -- The lead's account (scope lead) or the market's id (scope symbol), resolved when the request is filed.
  scope_ref text,
  status text NOT NULL DEFAULT 'awaiting_second'
    CONSTRAINT copy_bots_pause_requests_status_ck CHECK (status IN ('awaiting_second', 'applied')),
  approval_id text NOT NULL,
  proposed_by text NOT NULL CONSTRAINT copy_bots_pause_requests_proposer_ck CHECK (length(btrim(proposed_by)) > 0),
  approver_id text,
  confirmed_by text,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  CONSTRAINT copy_bots_pause_requests_applied_ck CHECK (
    status <> 'applied'
    OR (approver_id IS NOT NULL AND confirmed_by IS NOT NULL AND lower(btrim(approver_id)) <> lower(btrim(proposed_by))
        AND lower(btrim(confirmed_by)) <> lower(btrim(proposed_by)))
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS copy_bots_pause_requests_approval_idx ON trade.copy_bots_pause_requests (approval_id);
CREATE INDEX IF NOT EXISTS copy_bots_pause_requests_waiting_idx
  ON trade.copy_bots_pause_requests (created_at, id) WHERE status = 'awaiting_second';

-- One row per pause. A scope is paused while its row has no resumed_at; resuming closes the row, never deletes it.
CREATE TABLE IF NOT EXISTS trade.copy_bots_pauses (
  id uuid PRIMARY KEY,
  scope_kind text NOT NULL CONSTRAINT copy_bots_pauses_kind_ck CHECK (scope_kind IN ('lead', 'bot_type', 'symbol')),
  scope_value text NOT NULL CONSTRAINT copy_bots_pauses_value_ck CHECK (length(btrim(scope_value)) BETWEEN 1 AND 80),
  scope_ref text,
  pause_request_id uuid NOT NULL REFERENCES trade.copy_bots_pause_requests (id),
  paused_by text NOT NULL,
  pause_approver text NOT NULL,
  paused_at timestamptz NOT NULL,
  resume_request_id uuid REFERENCES trade.copy_bots_pause_requests (id),
  resumed_by text,
  resume_approver text,
  resumed_at timestamptz,
  CONSTRAINT copy_bots_pauses_resumed_ck CHECK (
    (resumed_at IS NULL AND resume_request_id IS NULL AND resumed_by IS NULL AND resume_approver IS NULL)
    OR (resumed_at IS NOT NULL AND resume_request_id IS NOT NULL AND resumed_by IS NOT NULL AND resume_approver IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS copy_bots_pauses_active_idx
  ON trade.copy_bots_pauses (scope_kind, scope_value) WHERE resumed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS copy_bots_pauses_pause_request_idx ON trade.copy_bots_pauses (pause_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS copy_bots_pauses_resume_request_idx
  ON trade.copy_bots_pauses (resume_request_id) WHERE resume_request_id IS NOT NULL;

-- A pause row only ever closes: its scope and who paused it never change, and a resumed row is final.
CREATE OR REPLACE FUNCTION trade.copy_bots_pauses_close_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.copy_bots_pauses: a pause is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.resumed_at IS NOT NULL
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind OR NEW.scope_value IS DISTINCT FROM OLD.scope_value
     OR NEW.scope_ref IS DISTINCT FROM OLD.scope_ref OR NEW.pause_request_id IS DISTINCT FROM OLD.pause_request_id
     OR NEW.paused_by IS DISTINCT FROM OLD.paused_by OR NEW.pause_approver IS DISTINCT FROM OLD.pause_approver
     OR NEW.paused_at IS DISTINCT FROM OLD.paused_at THEN
    RAISE EXCEPTION 'trade.copy_bots_pauses: only resuming may change a pause, once.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS copy_bots_pauses_close_only_trg ON trade.copy_bots_pauses;
CREATE TRIGGER copy_bots_pauses_close_only_trg
  BEFORE UPDATE OR DELETE ON trade.copy_bots_pauses
  FOR EACH ROW EXECUTE FUNCTION trade.copy_bots_pauses_close_only();

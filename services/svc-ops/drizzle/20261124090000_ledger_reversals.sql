-- svc-ops · an operator's corrective reversal of a posted ledger transaction (OPS-ledger-desk-02, ops ENGINE LC-1 to LC-6)
-- Reversal: 20261124090000_ledger_reversals.down.sql
--
-- One row per reversal asked for, written before anything else: the intent. `request_no` is the sequence the approval is
-- bound to; `ordinal` is the number the ledger key `ops:reversal:<original_tx_id>:<ordinal>` is built from, the next one for
-- that original, stored once and never reused. Nothing posts until a different person's approval is spent (`approval_id`,
-- `approver_id`). The ledger builds the compensating transaction itself from the stored original; this table only records
-- what svc-ops asked and what the ledger answered. A settled row never changes again, and no row is deleted.
CREATE TABLE ops.ledger_reversals (
 request_no bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 original_tx_id text NOT NULL CHECK (original_tx_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 ordinal bigint NOT NULL CHECK (ordinal >= 1),
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)),
 case_ref text NOT NULL CHECK (char_length(case_ref) BETWEEN 1 AND 128 AND case_ref = btrim(case_ref)),
 requested_by text NOT NULL,
 requested_at timestamptz NOT NULL,
 state text NOT NULL CHECK (state IN ('intent', 'posting', 'pending_retry', 'posted', 'refused')),
 ledger_key text NOT NULL UNIQUE,
 approval_id text UNIQUE,
 approver_id text,
 approved_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 last_attempt_at timestamptz,
 reversing_tx_id text,
 code text,
 reversed_by text,
 settled_at timestamptz,
 UNIQUE (original_tx_id, ordinal),
 CHECK (ledger_key = 'ops:reversal:' || original_tx_id || ':' || ordinal::text),
 -- Nothing leaves `intent` without a spent approval from someone other than the requester.
 CHECK ((state = 'intent') = (approval_id IS NULL)),
 CHECK (state = 'intent' OR (approver_id IS NOT NULL AND lower(approver_id) <> lower(requested_by))),
 CHECK (state <> 'intent' OR attempts = 0),
 CHECK ((state = 'posted') = (reversing_tx_id IS NOT NULL)),
 CHECK (state <> 'refused' OR code IS NOT NULL),
 CHECK ((state IN ('posted', 'refused')) = (settled_at IS NOT NULL))
);
CREATE INDEX ledger_reversals_original_idx ON ops.ledger_reversals (original_tx_id, request_no DESC);
-- One posted reversal per original here, as the ledger holds one per original in its book.
CREATE UNIQUE INDEX ledger_reversals_one_posted_idx ON ops.ledger_reversals (original_tx_id) WHERE state = 'posted';
CREATE INDEX ledger_reversals_open_idx ON ops.ledger_reversals (last_attempt_at) WHERE state IN ('posting', 'pending_retry');

-- The request is what was approved: its original, ordinal, key, words and requester never change; a settled row is history.
CREATE FUNCTION ops.ledger_reversals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'ops.ledger_reversals rows are never deleted' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.state IN ('posted', 'refused') THEN
  RAISE EXCEPTION 'a settled reversal request never changes' USING ERRCODE = 'restrict_violation';
 END IF;
 IF NEW.original_tx_id <> OLD.original_tx_id OR NEW.ordinal <> OLD.ordinal OR NEW.ledger_key <> OLD.ledger_key
    OR NEW.reason <> OLD.reason OR NEW.case_ref <> OLD.case_ref OR NEW.requested_by <> OLD.requested_by
    OR NEW.requested_at <> OLD.requested_at THEN
  RAISE EXCEPTION 'a reversal request keeps its original, key, words and requester' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.approval_id IS NOT NULL AND (NEW.approval_id IS DISTINCT FROM OLD.approval_id OR NEW.approver_id IS DISTINCT FROM OLD.approver_id) THEN
  RAISE EXCEPTION 'a reversal request is approved once' USING ERRCODE = 'restrict_violation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_reversals_guard BEFORE UPDATE OR DELETE ON ops.ledger_reversals
 FOR EACH ROW EXECUTE FUNCTION ops.ledger_reversals_guard();

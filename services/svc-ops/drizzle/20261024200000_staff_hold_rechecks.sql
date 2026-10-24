-- svc-ops · staff holds: fair settling order and a late post after `ledger.post_lost` (OPS-accounts-desk-01 follow-up)
-- Reversal: 20261024200000_staff_hold_rechecks.down.sql
--
-- `checked_at` is when the settling worker last looked at a movement, so it works through the oldest-looked-at first and
-- no group of movements keeps the front of the queue. A movement refused `ledger.post_lost` was declared dead because its
-- key was still missing 7 minutes after the last send, which is evidence, not proof. The worker reads such keys again for
-- a while, and if the post is found in the book the movement becomes `posted` (or, if another post holds the key,
-- `ledger.idempotency_conflict`): those changes, and `checked_at`, are the only ones a settled movement may ever take.
ALTER TABLE ops.staff_hold_movements ADD COLUMN checked_at timestamptz;

CREATE INDEX staff_hold_movements_lost_idx ON ops.staff_hold_movements (settled_at)
 WHERE status = 'refused' AND code = 'ledger.post_lost' AND uncertain;

CREATE OR REPLACE FUNCTION ops.staff_hold_movements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'ops.staff_hold_movements rows are never deleted' USING ERRCODE = 'restrict_violation';
 END IF;
 IF NEW.hold_no <> OLD.hold_no OR NEW.kind <> OLD.kind OR NEW.no <> OLD.no OR NEW.amount <> OLD.amount
    OR NEW.ledger_key <> OLD.ledger_key OR NEW.request_key <> OLD.request_key OR NEW.cause <> OLD.cause THEN
  RAISE EXCEPTION 'a staff hold movement keeps its key, number and amount' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.status = 'refused' AND OLD.code = 'ledger.post_lost' AND OLD.uncertain THEN
  -- Read again (only checked_at moves); found in the book after all (posted, with the transaction id); or found holding
  -- another post (refused ledger.idempotency_conflict, for good).
  IF (NEW.status = 'refused' AND NEW.code = 'ledger.post_lost' AND NEW.tx_id IS NULL
      AND NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at)
     OR (NEW.status = 'posted' AND NEW.tx_id IS NOT NULL AND NEW.code IS NULL)
     OR (NEW.status = 'refused' AND NEW.code = 'ledger.idempotency_conflict' AND NEW.tx_id IS NULL) THEN
   IF NOT NEW.uncertain OR NEW.attempts <> OLD.attempts OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
      OR NEW.requester_id IS DISTINCT FROM OLD.requester_id OR NEW.approver_id IS DISTINCT FROM OLD.approver_id
      OR NEW.confirm_account IS DISTINCT FROM OLD.confirm_account OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.created_at <> OLD.created_at OR NEW.last_attempt_at IS DISTINCT FROM OLD.last_attempt_at THEN
    RAISE EXCEPTION 'a lost staff hold movement keeps its request' USING ERRCODE = 'restrict_violation';
   END IF;
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a lost staff hold movement only becomes posted' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.status IN ('posted', 'refused') THEN
  RAISE EXCEPTION 'a settled staff hold movement never changes' USING ERRCODE = 'restrict_violation';
 END IF;
 RETURN NEW;
END $$;

-- intafaced:destructive — reversal of 20261024200000_staff_hold_rechecks.sql
--
-- Restores the original guard (a settled movement never changes) and drops `checked_at`, which only records when the
-- settling worker last looked at a movement; no answer, key or amount is lost. A lost movement that was found in the
-- book keeps its `posted` answer.
CREATE OR REPLACE FUNCTION ops.staff_hold_movements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'ops.staff_hold_movements rows are never deleted' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.status IN ('posted', 'refused') THEN
  RAISE EXCEPTION 'a settled staff hold movement never changes' USING ERRCODE = 'restrict_violation';
 END IF;
 IF NEW.hold_no <> OLD.hold_no OR NEW.kind <> OLD.kind OR NEW.no <> OLD.no OR NEW.amount <> OLD.amount
    OR NEW.ledger_key <> OLD.ledger_key OR NEW.request_key <> OLD.request_key OR NEW.cause <> OLD.cause THEN
  RAISE EXCEPTION 'a staff hold movement keeps its key, number and amount' USING ERRCODE = 'restrict_violation';
 END IF;
 RETURN NEW;
END $$;
DROP INDEX IF EXISTS ops.staff_hold_movements_lost_idx;
ALTER TABLE ops.staff_hold_movements DROP COLUMN IF EXISTS checked_at;

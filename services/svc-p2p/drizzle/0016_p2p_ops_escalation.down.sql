-- Reverse 0016. Restores the 0013 ruling freeze (no four_eyes) and drops
-- the escalation actor columns. Resolved rulings already stored are not rewritten.
CREATE OR REPLACE FUNCTION "p2p"."p2p_disputes_resolved_ruling_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'resolved'
     AND ROW(NEW."status", NEW."resolution", NEW."moderator_id", NEW."resolved_at", NEW."resolution_notes", NEW."trade_id", NEW."opened_by")
       IS DISTINCT FROM ROW(OLD."status", OLD."resolution", OLD."moderator_id", OLD."resolved_at", OLD."resolution_notes", OLD."trade_id", OLD."opened_by") THEN
    RAISE EXCEPTION
      'p2p: a resolved dispute ruling cannot change — p2p_disputes_resolved_ruling_frozen dispute % stays %',
      OLD."id", OLD."resolution"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "p2p"."p2p_disputes" DROP CONSTRAINT IF EXISTS "p2p_disputes_four_eyes_when_open_ck";
ALTER TABLE "p2p"."p2p_disputes" DROP CONSTRAINT IF EXISTS "p2p_disputes_escalation_reason_ck";
ALTER TABLE "p2p"."p2p_disputes" DROP CONSTRAINT IF EXISTS "p2p_disputes_escalated_by_person_ck";
ALTER TABLE "p2p"."p2p_disputes" DROP COLUMN IF EXISTS "four_eyes";
ALTER TABLE "p2p"."p2p_disputes" DROP COLUMN IF EXISTS "escalation_reason";
ALTER TABLE "p2p"."p2p_disputes" DROP COLUMN IF EXISTS "escalated_by";

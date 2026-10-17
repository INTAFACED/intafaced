-- svc-p2p · who escalated a dispute, and whether the ruling had a second person.
-- Reversal: 0016_p2p_ops_escalation.down.sql
--
-- NOT tagged `intafaced:destructive`: adds columns and replaces a trigger
-- function. Drops no table, column, or row.
--
-- Manual escalation records the moderator. The timeout sweep still re-arms
-- without a person, so escalated_by stays null on that path.
-- four_eyes is written when a dispute is resolved. false is the default-off
-- single-moderator ruling. true means an approval was consumed in that same
-- transaction. Open rows stay null. Existing resolved rows are not rewritten.

ALTER TABLE "p2p"."p2p_disputes" ADD COLUMN IF NOT EXISTS "escalated_by" text;
ALTER TABLE "p2p"."p2p_disputes" ADD COLUMN IF NOT EXISTS "escalation_reason" text;
ALTER TABLE "p2p"."p2p_disputes" ADD COLUMN IF NOT EXISTS "four_eyes" boolean;

ALTER TABLE "p2p"."p2p_disputes" DROP CONSTRAINT IF EXISTS "p2p_disputes_escalated_by_person_ck";
ALTER TABLE "p2p"."p2p_disputes" ADD CONSTRAINT "p2p_disputes_escalated_by_person_ck"
  CHECK ("escalated_by" IS NULL OR "p2p"."is_natural_person_id"("escalated_by"));

ALTER TABLE "p2p"."p2p_disputes" DROP CONSTRAINT IF EXISTS "p2p_disputes_escalation_reason_ck";
ALTER TABLE "p2p"."p2p_disputes" ADD CONSTRAINT "p2p_disputes_escalation_reason_ck"
  CHECK ("escalation_reason" IS NULL OR char_length("escalation_reason") BETWEEN 1 AND 2000);

ALTER TABLE "p2p"."p2p_disputes" DROP CONSTRAINT IF EXISTS "p2p_disputes_four_eyes_when_open_ck";
ALTER TABLE "p2p"."p2p_disputes" ADD CONSTRAINT "p2p_disputes_four_eyes_when_open_ck"
  CHECK ("status" <> 'open' OR "four_eyes" IS NULL);

CREATE OR REPLACE FUNCTION "p2p"."p2p_disputes_resolved_ruling_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'resolved'
     AND ROW(NEW."status", NEW."resolution", NEW."moderator_id", NEW."resolved_at", NEW."resolution_notes", NEW."trade_id", NEW."opened_by", NEW."four_eyes")
       IS DISTINCT FROM ROW(OLD."status", OLD."resolution", OLD."moderator_id", OLD."resolved_at", OLD."resolution_notes", OLD."trade_id", OLD."opened_by", OLD."four_eyes") THEN
    RAISE EXCEPTION
      'p2p: a resolved dispute ruling cannot change — p2p_disputes_resolved_ruling_frozen dispute % stays %',
      OLD."id", OLD."resolution"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

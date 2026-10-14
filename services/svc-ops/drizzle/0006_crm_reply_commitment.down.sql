-- FORWARD-ONLY FOR RECORDS. This reverses the schema only. The commitment field and the stage and due-time history fields
-- (fromStage, toStage, fromDueAt, toDueAt, fromCommitment, toCommitment) stay inside the stored JSON records, and code from before
-- this migration has strict schemas that REJECT those fields. Rolling back the database without rolling back the code leaves any
-- record that has them unreadable by the old code. Deploy svc-ops and the admin console together, and roll them back together.
DROP INDEX IF EXISTS ops.crm_outbox_opportunity_touch;
-- Interactions are append-only, so recorded reply_sent rows cannot be removed. NOT VALID restores the old rule for every new
-- row without failing on the rows already recorded.
ALTER TABLE ops.crm_interactions DROP CONSTRAINT IF EXISTS crm_interactions_kind_check;
ALTER TABLE ops.crm_interactions ADD CONSTRAINT crm_interactions_kind_check
 CHECK(kind IN ('call_invited','call_booked','follow_up')) NOT VALID;

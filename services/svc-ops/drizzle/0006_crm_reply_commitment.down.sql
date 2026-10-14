DROP INDEX IF EXISTS ops.crm_outbox_opportunity_touch;
-- Interactions are append-only, so recorded reply_sent rows cannot be removed. NOT VALID restores the old rule for every new
-- row without failing on the rows already recorded.
ALTER TABLE ops.crm_interactions DROP CONSTRAINT IF EXISTS crm_interactions_kind_check;
ALTER TABLE ops.crm_interactions ADD CONSTRAINT crm_interactions_kind_check
 CHECK(kind IN ('call_invited','call_booked','follow_up')) NOT VALID;

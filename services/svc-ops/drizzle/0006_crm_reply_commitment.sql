-- Reply state and commitments for the founder inbox. Nothing is backfilled: first reply and last touch are derived from the
-- queued messages (ops.crm_outbox), recorded interactions and stage-change activities that already exist, and a commitment
-- lives in the opportunity record (null until a founder sets one).
-- A reply sent outside the console (for example from Gmail) is recorded as an interaction of kind reply_sent.
ALTER TABLE ops.crm_interactions DROP CONSTRAINT crm_interactions_kind_check;
ALTER TABLE ops.crm_interactions ADD CONSTRAINT crm_interactions_kind_check
 CHECK(kind IN ('call_invited','call_booked','follow_up','reply_sent'));
-- Staff messages are found per opportunity to derive first reply and last touch; the table had no such index.
CREATE INDEX crm_outbox_opportunity_touch ON ops.crm_outbox(opportunity_id,created_at) WHERE opportunity_id IS NOT NULL;

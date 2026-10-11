DROP TRIGGER IF EXISTS crm_submission_origin_immutable ON ops.crm_submissions;
DROP FUNCTION IF EXISTS ops.crm_submission_origin_immutable();
DROP TABLE IF EXISTS ops.crm_workflow_audit;
DROP TABLE IF EXISTS ops.crm_interactions;
DROP TABLE IF EXISTS ops.crm_contact_merges;
DROP FUNCTION IF EXISTS ops.crm_workflow_append_only();
DROP TABLE IF EXISTS ops.crm_contact_aliases;
DROP TABLE IF EXISTS ops.crm_source_mappings;
DROP TABLE IF EXISTS ops.crm_campaigns;
DROP INDEX IF EXISTS ops.crm_tasks_one_primary_pending;
DROP INDEX IF EXISTS ops.crm_tasks_status_owner;
DROP INDEX IF EXISTS ops.crm_tasks_due;
ALTER TABLE ops.crm_tasks DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS owner_user_id, DROP COLUMN IF EXISTS due_at, DROP COLUMN IF EXISTS created_at, DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS revision;
DROP INDEX IF EXISTS ops.crm_contacts_email;
ALTER TABLE ops.crm_contacts DROP COLUMN IF EXISTS revision;

ALTER TABLE ops.crm_submissions DROP COLUMN IF EXISTS first_completed_at;

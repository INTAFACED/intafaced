DROP FUNCTION IF EXISTS ops.crm_apply_erasure(uuid);
DROP TRIGGER IF EXISTS crm_contact_delete_guard ON ops.crm_contacts;
DROP TRIGGER IF EXISTS crm_submission_delete_guard ON ops.crm_submissions;
DROP TRIGGER IF EXISTS crm_opportunity_delete_guard ON ops.crm_opportunities;
DROP TRIGGER IF EXISTS crm_outbox_delete_guard ON ops.crm_outbox;
DROP TRIGGER IF EXISTS crm_task_delete_guard ON ops.crm_tasks;
DROP FUNCTION IF EXISTS ops.crm_private_delete_guard();
CREATE OR REPLACE FUNCTION ops.crm_activity_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ops.crm.activity_immutable'; END;
$$;
CREATE OR REPLACE FUNCTION ops.crm_workflow_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ops.crm.workflow_history_immutable'; END;
$$;
DROP FUNCTION IF EXISTS ops.crm_erasure_delete_allowed(text,jsonb);
DROP TABLE IF EXISTS ops.crm_erased_requests,ops.crm_privacy_requests,ops.crm_erasure_notifications,ops.crm_erasure_intents;

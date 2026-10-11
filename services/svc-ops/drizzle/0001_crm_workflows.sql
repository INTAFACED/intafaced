ALTER TABLE ops.crm_submissions ADD COLUMN first_completed_at timestamptz;
UPDATE ops.crm_submissions SET first_completed_at=(record->>'completedAt')::timestamptz WHERE record->>'completedAt' IS NOT NULL;
-- CRM provenance is separate from original contact/submission snapshots.
ALTER TABLE ops.crm_contacts ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision > 0);
CREATE INDEX crm_contacts_email ON ops.crm_contacts ((lower(record->>'email')),id);
CREATE TABLE ops.crm_campaigns (
 id uuid PRIMARY KEY, revision integer NOT NULL CHECK(revision > 0),
 created_at timestamptz NOT NULL, record jsonb NOT NULL
);
CREATE TABLE ops.crm_source_mappings (
 id uuid PRIMARY KEY, source_key text NOT NULL UNIQUE CHECK(source_key ~ '^[A-Za-z0-9_-]{16,128}$'),
 campaign_id uuid NOT NULL REFERENCES ops.crm_campaigns(id),
 revision integer NOT NULL CHECK(revision > 0), status text NOT NULL CHECK(status IN ('active','disabled')),
 created_at timestamptz NOT NULL, record jsonb NOT NULL
);
CREATE INDEX crm_source_mappings_page ON ops.crm_source_mappings(created_at DESC,id DESC);
CREATE TABLE ops.crm_contact_aliases (
 contact_id uuid PRIMARY KEY REFERENCES ops.crm_contacts(id),
 canonical_contact_id uuid NOT NULL REFERENCES ops.crm_contacts(id),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 CHECK(contact_id<>canonical_contact_id)
);
CREATE INDEX crm_contact_aliases_canonical ON ops.crm_contact_aliases(canonical_contact_id);
CREATE TABLE ops.crm_contact_merges (
 id uuid PRIMARY KEY, source_contact_id uuid NOT NULL REFERENCES ops.crm_contacts(id),
 target_contact_id uuid NOT NULL REFERENCES ops.crm_contacts(id), request_id uuid NOT NULL UNIQUE,
 actor_user_id uuid NOT NULL, merged_at timestamptz NOT NULL, record jsonb NOT NULL
);
ALTER TABLE ops.crm_tasks ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE ops.crm_tasks ADD COLUMN kind text NOT NULL DEFAULT 'next_action' CHECK(kind IN ('next_action','follow_up','call_invitation'));
-- Legacy tasks did not record a creation timestamp. Preserve that unknown value.
ALTER TABLE ops.crm_tasks ADD COLUMN created_at timestamptz;
ALTER TABLE ops.crm_tasks ADD COLUMN due_at timestamptz;
ALTER TABLE ops.crm_tasks ADD COLUMN owner_user_id uuid;
ALTER TABLE ops.crm_tasks ADD COLUMN status text;
UPDATE ops.crm_tasks SET due_at=(record->>'dueAt')::timestamptz, owner_user_id=(record->>'ownerUserId')::uuid, status=record->>'status';
ALTER TABLE ops.crm_tasks ALTER COLUMN due_at SET NOT NULL;
ALTER TABLE ops.crm_tasks ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE ops.crm_tasks ALTER COLUMN status SET NOT NULL;
ALTER TABLE ops.crm_tasks ADD CHECK(status IN ('pending','completed','cancelled'));
CREATE INDEX crm_tasks_due ON ops.crm_tasks(due_at,id);
CREATE INDEX crm_tasks_status_owner ON ops.crm_tasks(status,owner_user_id,due_at,id);
CREATE UNIQUE INDEX crm_tasks_one_primary_pending ON ops.crm_tasks(opportunity_id) WHERE kind='next_action' AND status='pending';
CREATE TABLE ops.crm_interactions (
 id uuid PRIMARY KEY, opportunity_id uuid NOT NULL REFERENCES ops.crm_opportunities(id),
 actor_user_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('call_invited','call_booked','follow_up')),
 occurred_at timestamptz NOT NULL, record jsonb NOT NULL
);
CREATE INDEX crm_interactions_opportunity ON ops.crm_interactions(opportunity_id,occurred_at,id);
CREATE UNIQUE INDEX crm_interaction_evidence ON ops.crm_interactions(opportunity_id,kind,(record->>'evidenceRef'));
CREATE TABLE ops.crm_workflow_audit (
 id uuid PRIMARY KEY, request_id uuid NOT NULL, actor_user_id uuid NOT NULL,
 subject_type text NOT NULL CHECK(subject_type IN ('campaign','source_mapping','contact','opportunity','task','export')),
 subject_id uuid NOT NULL, kind text NOT NULL, occurred_at timestamptz NOT NULL, record jsonb NOT NULL
);
CREATE INDEX crm_workflow_audit_page ON ops.crm_workflow_audit(subject_type,subject_id,occurred_at DESC,id DESC);
CREATE FUNCTION ops.crm_workflow_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ops.crm.workflow_history_immutable'; END;
$$;
CREATE TRIGGER crm_merge_append_only BEFORE UPDATE OR DELETE ON ops.crm_contact_merges FOR EACH ROW EXECUTE FUNCTION ops.crm_workflow_append_only();
CREATE TRIGGER crm_interaction_append_only BEFORE UPDATE OR DELETE ON ops.crm_interactions FOR EACH ROW EXECUTE FUNCTION ops.crm_workflow_append_only();
CREATE TRIGGER crm_workflow_audit_append_only BEFORE UPDATE OR DELETE ON ops.crm_workflow_audit FOR EACH ROW EXECUTE FUNCTION ops.crm_workflow_append_only();
-- Staff merges may move opportunity links, but never the origin of a submission.
CREATE FUNCTION ops.crm_submission_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i integer;
BEGIN
 IF NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.original_contact IS DISTINCT FROM OLD.original_contact
   OR NEW.attribution IS DISTINCT FROM OLD.attribution OR (NEW.record->'contact')-'interests' IS DISTINCT FROM (OLD.record->'contact')-'interests'
   OR (OLD.first_completed_at IS NOT NULL AND NEW.first_completed_at IS DISTINCT FROM OLD.first_completed_at)
   OR NEW.record->>'contactId' IS DISTINCT FROM OLD.record->>'contactId'
   OR NEW.record->>'capturedAt' IS DISTINCT FROM OLD.record->>'capturedAt' THEN
  RAISE EXCEPTION 'ops.crm.submission_origin_immutable';
 END IF;
 IF jsonb_array_length(NEW.record->'contact'->'interests') < jsonb_array_length(OLD.record->'contact'->'interests') THEN
  RAISE EXCEPTION 'ops.crm.interests_append_only';
 END IF;
 FOR i IN SELECT generate_series(0,jsonb_array_length(OLD.record->'contact'->'interests')-1) LOOP
  IF NEW.record->'contact'->'interests'->i IS DISTINCT FROM OLD.record->'contact'->'interests'->i THEN
   RAISE EXCEPTION 'ops.crm.interests_append_only';
  END IF;
 END LOOP;
 IF jsonb_array_length(NEW.record->'questionnaires') < jsonb_array_length(OLD.record->'questionnaires') THEN
  RAISE EXCEPTION 'ops.crm.answers_immutable';
 END IF;
 FOR i IN SELECT generate_series(0,jsonb_array_length(OLD.record->'questionnaires')-1) LOOP
  IF NEW.record->'questionnaires'->i IS DISTINCT FROM OLD.record->'questionnaires'->i THEN
   RAISE EXCEPTION 'ops.crm.answers_immutable';
  END IF;
 END LOOP;
 RETURN NEW;
END;
$$;
CREATE TRIGGER crm_submission_origin_immutable BEFORE UPDATE ON ops.crm_submissions FOR EACH ROW EXECUTE FUNCTION ops.crm_submission_origin_immutable();

-- IDs and typed outcomes only: no contact values, answers, staff text or capability hashes.
CREATE TABLE ops.crm_erasure_intents (
 id uuid PRIMARY KEY, canonical_contact_id uuid NOT NULL, actor_user_id uuid NOT NULL,
 request_id uuid NOT NULL UNIQUE, reason text NOT NULL CHECK(reason IN ('confirmed_privacy_request','approved_retention_policy')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL DEFAULT 'pending_notify' CHECK(status IN ('pending_notify','complete')),
 requested_at timestamptz NOT NULL, completed_at timestamptz, error_code text,
 contact_ids uuid[] NOT NULL, submission_ids uuid[] NOT NULL, opportunity_ids uuid[] NOT NULL,
 snapshot text NOT NULL CHECK(snapshot ~ '^[a-f0-9]{64}$'),
 CHECK((status='complete')=(completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX crm_erasure_cluster ON ops.crm_erasure_intents(canonical_contact_id);
CREATE TABLE ops.crm_erasure_notifications (
 intent_id uuid NOT NULL REFERENCES ops.crm_erasure_intents(id), submission_id uuid NOT NULL,
 request_id uuid NOT NULL UNIQUE, receipt jsonb,
 PRIMARY KEY(intent_id,submission_id),
 CHECK(receipt IS NULL OR (receipt->>'requestId'=request_id::text AND receipt->>'submissionId'=submission_id::text))
);
CREATE TABLE ops.crm_privacy_requests (
 request_id uuid PRIMARY KEY, actor_user_id uuid NOT NULL, operation text NOT NULL,
 fingerprint text NOT NULL, intent_id uuid NOT NULL REFERENCES ops.crm_erasure_intents(id)
);
CREATE TABLE ops.crm_erased_requests (request_id uuid PRIMARY KEY);

CREATE FUNCTION ops.crm_erasure_delete_allowed(table_name text, row_value jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM ops.crm_erasure_intents e
  WHERE e.id::text=current_setting('ops.crm.erasure_intent',true)
   AND NOT EXISTS(SELECT 1 FROM ops.crm_erasure_notifications n WHERE n.intent_id=e.id AND n.receipt IS NULL)
   AND CASE table_name
    WHEN 'crm_contacts' THEN (row_value->>'id')::uuid=ANY(e.contact_ids)
    WHEN 'crm_submissions' THEN (row_value->>'id')::uuid=ANY(e.submission_ids)
    WHEN 'crm_opportunities' THEN (row_value->>'id')::uuid=ANY(e.opportunity_ids)
    WHEN 'crm_outbox' THEN (row_value->>'submission_id')::uuid=ANY(e.submission_ids)
    WHEN 'crm_tasks' THEN (row_value->>'opportunity_id')::uuid=ANY(e.opportunity_ids)
    WHEN 'crm_activities' THEN (row_value->>'opportunity_id')::uuid=ANY(e.opportunity_ids)
    WHEN 'crm_interactions' THEN (row_value->>'opportunity_id')::uuid=ANY(e.opportunity_ids)
    WHEN 'crm_contact_merges' THEN (row_value->>'source_contact_id')::uuid=ANY(e.contact_ids) OR (row_value->>'target_contact_id')::uuid=ANY(e.contact_ids)
    WHEN 'crm_workflow_audit' THEN (row_value->>'subject_id')::uuid=ANY(e.contact_ids || e.opportunity_ids)
     OR (row_value->>'subject_type'='export' AND EXISTS(SELECT 1 FROM ops.crm_requests r JOIN ops.crm_erased_requests x USING(request_id) WHERE r.result->>'exportId'=row_value->>'subject_id'))
     OR EXISTS(SELECT 1 FROM ops.crm_tasks t WHERE t.id=(row_value->>'subject_id')::uuid AND t.opportunity_id=ANY(e.opportunity_ids))
    ELSE false END
 );
$$;
CREATE FUNCTION ops.crm_private_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ops.crm_erasure_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'ops.crm.erasure_required';
END;
$$;
CREATE TRIGGER crm_contact_delete_guard BEFORE DELETE ON ops.crm_contacts FOR EACH ROW EXECUTE FUNCTION ops.crm_private_delete_guard();
CREATE TRIGGER crm_submission_delete_guard BEFORE DELETE ON ops.crm_submissions FOR EACH ROW EXECUTE FUNCTION ops.crm_private_delete_guard();
CREATE TRIGGER crm_opportunity_delete_guard BEFORE DELETE ON ops.crm_opportunities FOR EACH ROW EXECUTE FUNCTION ops.crm_private_delete_guard();
CREATE TRIGGER crm_outbox_delete_guard BEFORE DELETE ON ops.crm_outbox FOR EACH ROW EXECUTE FUNCTION ops.crm_private_delete_guard();
CREATE TRIGGER crm_task_delete_guard BEFORE DELETE ON ops.crm_tasks FOR EACH ROW EXECUTE FUNCTION ops.crm_private_delete_guard();
CREATE OR REPLACE FUNCTION ops.crm_activity_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND ops.crm_erasure_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'ops.crm.activity_immutable';
END;
$$;
CREATE OR REPLACE FUNCTION ops.crm_workflow_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND ops.crm_erasure_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'ops.crm.workflow_history_immutable';
END;
$$;

-- Called only after all exact original notify erasure receipts have committed.
-- It also reapplies a completed tombstone to a restored, quarantined ops database.
CREATE FUNCTION ops.crm_apply_erasure(intent uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e ops.crm_erasure_intents; orgs uuid[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('ops.crm.privacy'));
 SELECT * INTO e FROM ops.crm_erasure_intents WHERE id=intent FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM ops.crm_erasure_notifications n WHERE n.intent_id=intent AND n.receipt IS NULL)
  OR (SELECT count(*) FROM ops.crm_erasure_notifications WHERE intent_id=intent)<>cardinality(e.submission_ids) THEN
  RAISE EXCEPTION 'ops.crm.erasure_evidence_missing';
 END IF;
 IF EXISTS(SELECT 1 FROM ops.crm_outbox WHERE submission_id=ANY(e.submission_ids) AND lease_until>clock_timestamp()) THEN
  RAISE EXCEPTION 'ops.crm.notification_in_flight';
 END IF;
 PERFORM set_config('ops.crm.erasure_intent',intent::text,true);
 SELECT array_agg(DISTINCT organisation_id) INTO orgs FROM ops.crm_contact_organisations WHERE contact_id=ANY(e.contact_ids);
 INSERT INTO ops.crm_erased_requests(request_id)
  SELECT request_id FROM ops.crm_requests r WHERE r.submission_id=ANY(e.submission_ids)
   OR EXISTS(SELECT 1 FROM unnest(e.contact_ids || e.submission_ids || e.opportunity_ids) selected_id WHERE position(selected_id::text IN r.result::text)>0)
  ON CONFLICT DO NOTHING;
 DELETE FROM ops.crm_workflow_audit WHERE subject_id=ANY(e.contact_ids || e.opportunity_ids)
  OR (subject_type='export' AND EXISTS(SELECT 1 FROM ops.crm_requests r JOIN ops.crm_erased_requests x USING(request_id) WHERE r.result->>'exportId'=ops.crm_workflow_audit.subject_id::text))
  OR subject_id IN (SELECT id FROM ops.crm_tasks WHERE opportunity_id=ANY(e.opportunity_ids));
 DELETE FROM ops.crm_requests WHERE request_id IN (SELECT request_id FROM ops.crm_erased_requests);
 DELETE FROM ops.crm_activities WHERE opportunity_id=ANY(e.opportunity_ids);
 DELETE FROM ops.crm_interactions WHERE opportunity_id=ANY(e.opportunity_ids);
 DELETE FROM ops.crm_tasks WHERE opportunity_id=ANY(e.opportunity_ids);
 DELETE FROM ops.crm_outbox WHERE submission_id=ANY(e.submission_ids);
 DELETE FROM ops.crm_opportunities WHERE id=ANY(e.opportunity_ids);
 DELETE FROM ops.crm_submissions WHERE id=ANY(e.submission_ids);
 DELETE FROM ops.crm_contact_merges WHERE source_contact_id=ANY(e.contact_ids) OR target_contact_id=ANY(e.contact_ids);
 DELETE FROM ops.crm_contact_aliases WHERE contact_id=ANY(e.contact_ids) OR canonical_contact_id=ANY(e.contact_ids);
 DELETE FROM ops.crm_contact_organisations WHERE contact_id=ANY(e.contact_ids);
 DELETE FROM ops.crm_contacts WHERE id=ANY(e.contact_ids);
 DELETE FROM ops.crm_organisations o WHERE id=ANY(orgs) AND NOT EXISTS(SELECT 1 FROM ops.crm_contact_organisations c WHERE c.organisation_id=o.id)
  AND NOT EXISTS(SELECT 1 FROM ops.crm_opportunities p WHERE p.organisation_id=o.id);
 PERFORM set_config('ops.crm.erasure_intent','',true);
END;
$$;
REVOKE ALL ON FUNCTION ops.crm_apply_erasure(uuid) FROM PUBLIC;

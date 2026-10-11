ALTER TABLE ops.crm_outbox ADD COLUMN dispatch_payload jsonb;
ALTER TABLE ops.crm_outbox ADD COLUMN notification_receipt jsonb;
ALTER TABLE ops.crm_outbox ADD COLUMN lease_token uuid;
ALTER TABLE ops.crm_outbox ADD COLUMN lease_until timestamptz;
ALTER TABLE ops.crm_outbox ADD COLUMN retry_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE ops.crm_outbox ADD COLUMN opportunity_id uuid REFERENCES ops.crm_opportunities(id);
ALTER TABLE ops.crm_outbox ADD COLUMN actor_user_id uuid;
CREATE INDEX crm_outbox_dispatch ON ops.crm_outbox(retry_at,created_at,id) WHERE status IN ('pending','unconfigured');
CREATE FUNCTION ops.crm_dispatch_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.business_key IS DISTINCT FROM OLD.business_key OR NEW.submission_id IS DISTINCT FROM OLD.submission_id
   OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.payload IS DISTINCT FROM OLD.payload
   OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
   OR (OLD.dispatch_payload IS NOT NULL AND NEW.dispatch_payload IS DISTINCT FROM OLD.dispatch_payload) THEN
  RAISE EXCEPTION 'ops.crm.dispatch_origin_immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER crm_dispatch_origin_immutable BEFORE UPDATE ON ops.crm_outbox FOR EACH ROW EXECUTE FUNCTION ops.crm_dispatch_origin_immutable();

-- The service migration runner creates or uses its preprovisioned owned schema.
CREATE TABLE ops.crm_contacts (id uuid PRIMARY KEY, record jsonb NOT NULL);
CREATE TABLE ops.crm_organisations (id uuid PRIMARY KEY, record jsonb NOT NULL);
CREATE TABLE ops.crm_contact_organisations (contact_id uuid REFERENCES ops.crm_contacts(id), organisation_id uuid REFERENCES ops.crm_organisations(id), PRIMARY KEY(contact_id, organisation_id));
CREATE TABLE ops.crm_submissions (
 id uuid PRIMARY KEY, contact_id uuid NOT NULL REFERENCES ops.crm_contacts(id),
 capability_hash text NOT NULL, expires_at timestamptz NOT NULL,
 revision integer NOT NULL CHECK(revision > 0), record jsonb NOT NULL,
 attribution jsonb NOT NULL DEFAULT '{}', original_contact jsonb NOT NULL
);
CREATE TABLE ops.crm_opportunities (
 id uuid PRIMARY KEY, submission_id uuid NOT NULL REFERENCES ops.crm_submissions(id),
 contact_id uuid NOT NULL REFERENCES ops.crm_contacts(id), organisation_id uuid REFERENCES ops.crm_organisations(id),
 audience text NOT NULL CHECK(audience IN ('investor','trader','merchant','academy','partner')),
 stage text NOT NULL, owner_user_id uuid NOT NULL, revision integer NOT NULL CHECK(revision > 0),
 created_at timestamptz NOT NULL, record jsonb NOT NULL, UNIQUE(submission_id,audience),
 CHECK((audience='investor' AND stage IN ('new','qualified','diligence','terms','closed')) OR
 (audience<>'investor' AND stage IN ('new','qualified','invited','onboarding','closed')))
);
CREATE INDEX crm_opportunities_page ON ops.crm_opportunities(created_at DESC,id DESC);
CREATE INDEX crm_opportunities_filters ON ops.crm_opportunities(audience,stage,owner_user_id);
CREATE TABLE ops.crm_activities (id uuid PRIMARY KEY, opportunity_id uuid NOT NULL REFERENCES ops.crm_opportunities(id), sequence integer NOT NULL, record jsonb NOT NULL, UNIQUE(opportunity_id,sequence));
CREATE TABLE ops.crm_tasks (id uuid PRIMARY KEY, opportunity_id uuid NOT NULL REFERENCES ops.crm_opportunities(id), record jsonb NOT NULL);
CREATE TABLE ops.crm_requests (request_id uuid PRIMARY KEY, actor_key text NOT NULL, operation text NOT NULL, fingerprint text NOT NULL, submission_id uuid REFERENCES ops.crm_submissions(id), result jsonb NOT NULL);
CREATE TABLE ops.crm_outbox (
 id uuid PRIMARY KEY, business_key text NOT NULL UNIQUE, submission_id uuid NOT NULL REFERENCES ops.crm_submissions(id),
 kind text NOT NULL, status text NOT NULL CHECK(status IN ('pending','unconfigured','accepted','delivered','failed','unresolved')),
 payload jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0, acceptance_ref text, error_code text
);
CREATE TABLE ops.crm_rate_windows (key_hash text NOT NULL, window_start timestamptz NOT NULL, attempts integer NOT NULL, PRIMARY KEY(key_hash,window_start));

-- Staff/prospect activity history is append-only even through accidental service SQL.
CREATE FUNCTION ops.crm_activity_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ops.crm.activity_immutable'; END;
$$;
CREATE TRIGGER crm_activity_append_only BEFORE UPDATE OR DELETE ON ops.crm_activities
FOR EACH ROW EXECUTE FUNCTION ops.crm_activity_append_only();

-- Compliance case store (OPS-cases-01): inboxes, cases, an append-only case event log, and an outbox so a stored case and the event
-- that announces it commit together.
CREATE TABLE ops.compliance_inboxes (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 version integer NOT NULL CHECK(version >= 1),
 entity_type text NOT NULL CHECK(entity_type IN ('user','business','account','transfer')),
 workflow text NOT NULL CHECK(length(workflow) BETWEEN 1 AND 80),
 filter jsonb NOT NULL,
 owner text NOT NULL,
 members text[] NOT NULL,
 created_at timestamptz NOT NULL,
 UNIQUE (name, version)
);
CREATE TABLE ops.compliance_inbox_favourites (
 operator text NOT NULL,
 inbox_id text NOT NULL REFERENCES ops.compliance_inboxes(id),
 PRIMARY KEY (operator, inbox_id)
);
CREATE TABLE ops.compliance_cases (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
 name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('screening_hit','kyc_review','network_flag','manual')),
 type text NOT NULL CHECK(type IN ('alert','monitoring')),
 subject_id text NOT NULL,
 entity_type text NOT NULL CHECK(entity_type IN ('user','business','account','transfer')),
 inbox_id text NOT NULL REFERENCES ops.compliance_inboxes(id),
 status text NOT NULL CHECK(status IN ('pending','cleared','rejected','partner_cleared')),
 review_level text CHECK(review_level IN ('green','yellow','red')),
 assignee text,
 tags text[] NOT NULL,
 snoozed_until timestamptz,
 due_at timestamptz,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL
);
CREATE INDEX compliance_cases_inbox_idx ON ops.compliance_cases (inbox_id, created_at DESC, id DESC);
CREATE TABLE ops.compliance_case_events (
 case_id text NOT NULL REFERENCES ops.compliance_cases(id),
 seq integer NOT NULL CHECK(seq >= 1),
 action text NOT NULL,
 actor text NOT NULL,
 detail jsonb NOT NULL,
 at timestamptz NOT NULL,
 PRIMARY KEY (case_id, seq)
);
CREATE FUNCTION ops.compliance_case_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.compliance_case_event_immutable';
END $$;
CREATE TRIGGER compliance_case_events_append_only BEFORE UPDATE OR DELETE ON ops.compliance_case_events FOR EACH ROW EXECUTE FUNCTION ops.compliance_case_events_append_only();
CREATE TABLE ops.compliance_outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event text NOT NULL CHECK(event IN ('coreOpsComplianceCaseCreated','coreOpsComplianceInboxUpdated')),
 idempotency_key text NOT NULL UNIQUE,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 published_at timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 last_error text
);

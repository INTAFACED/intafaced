-- Founder account controls. Reversal: 0025_founder_controls.down.sql.
ALTER TABLE "identity"."users"
  ADD COLUMN IF NOT EXISTS "identity_control_version" bigint NOT NULL DEFAULT 0
  CHECK ("identity_control_version" >= 0);

-- The first verified deployment pair is pinned; changing env cannot mint new operators.
CREATE TABLE "identity"."founder_control_configuration" (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  founder_ids uuid[] NOT NULL CHECK (cardinality(founder_ids) = 2 AND founder_ids[1] <> founder_ids[2]),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "identity"."founder_operator_entitlements" (
  user_id uuid PRIMARY KEY REFERENCES "identity"."users"(id),
  enabled boolean NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "identity"."founder_control_audit" (
  audit_id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  actor_id uuid,
  kind text NOT NULL CHECK (kind IN ('identity', 'entitlement', 'bootstrap')),
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "founder_control_audit_request_idx" ON "identity"."founder_control_audit" (request_id);
CREATE TABLE "identity"."founder_control_requests" (
  request_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  fingerprint text NOT NULL,
  audit_id uuid NOT NULL REFERENCES "identity"."founder_control_audit"(audit_id)
);
CREATE FUNCTION "identity"."founder_control_history_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'identity founder control history is immutable';
END;
$$;
CREATE TRIGGER "founder_control_audit_immutable" BEFORE UPDATE OR DELETE ON "identity"."founder_control_audit"
  FOR EACH ROW EXECUTE FUNCTION "identity"."founder_control_history_immutable"();
CREATE TRIGGER "founder_control_requests_immutable" BEFORE UPDATE OR DELETE ON "identity"."founder_control_requests"
  FOR EACH ROW EXECUTE FUNCTION "identity"."founder_control_history_immutable"();
CREATE TRIGGER "founder_control_configuration_immutable" BEFORE UPDATE OR DELETE ON "identity"."founder_control_configuration"
  FOR EACH ROW EXECUTE FUNCTION "identity"."founder_control_history_immutable"();

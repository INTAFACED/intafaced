-- Legal agreements register (RC-identity-12, TRD-0631). A fixed list of kinds (CHECK), immutable published versions that point at
-- owner-supplied text (never generated), and one acceptance row per (subject, kind, version) with the signer and time.
-- No balance, no ledger. Reversal: 0066_agreements.down.sql

-- The fixed list of kinds lives in this CHECK (and AGREEMENT_KINDS in contracts), not in a seeded table.
CREATE TABLE IF NOT EXISTS "identity"."agreement_versions" (
  "kind" text NOT NULL CHECK ("kind" IN ('trading', 'custody', 'margin', 'market_data', 'api', 'rfq_block', 'broker', 'off_exchange_settlement')),
  "version" integer NOT NULL CHECK ("version" >= 1),
  "jurisdiction" text NOT NULL CHECK (btrim("jurisdiction") <> ''),
  "text_ref" text NOT NULL CHECK (btrim("text_ref") <> ''),
  "dispute_venue" text NOT NULL CHECK (btrim("dispute_venue") <> ''),
  "published_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "published_by" uuid NOT NULL,
  "approved_by" uuid NOT NULL,
  PRIMARY KEY ("kind", "version")
);

-- Published versions are immutable: a change is a new version.
CREATE OR REPLACE FUNCTION "identity"."agreement_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'identity.agreement_version_immutable' USING ERRCODE = 'check_violation';
END;
$$;
DROP TRIGGER IF EXISTS "agreement_versions_immutable" ON "identity"."agreement_versions";
CREATE TRIGGER "agreement_versions_immutable" BEFORE UPDATE OR DELETE ON "identity"."agreement_versions"
  FOR EACH ROW EXECUTE FUNCTION "identity"."agreement_versions_immutable"();

CREATE TABLE IF NOT EXISTS "identity"."agreement_acceptances" (
  "subject_id" uuid NOT NULL,
  "subject_type" text NOT NULL CHECK ("subject_type" IN ('user', 'org')),
  "kind" text NOT NULL,
  "version" integer NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "signer_user_id" uuid NOT NULL,
  PRIMARY KEY ("subject_id", "kind", "version"),
  FOREIGN KEY ("kind", "version") REFERENCES "identity"."agreement_versions" ("kind", "version")
);

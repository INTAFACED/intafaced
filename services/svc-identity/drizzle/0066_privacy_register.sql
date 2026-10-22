-- Privacy register (RC-identity-11). One row per published (section, version). A version is published only by
-- consuming an APPROVED identity.privacy_publish action approval whose approver is not its requester (four-eyes,
-- the existing action_approvals mechanism). Rows are never updated or deleted, so an old version stays readable.
-- No balance, no ledger.
-- Reversal: 0066_privacy_register.down.sql

CREATE TABLE IF NOT EXISTS "identity"."privacy_register" (
  "section" text NOT NULL CHECK ("section" IN ('collection', 'residency', 'access', 'minimisation', 'retention', 'export', 'deletion', 'breach_response')),
  "version" integer NOT NULL CHECK ("version" > 0),
  "body_ref" text NOT NULL CHECK (btrim("body_ref") <> ''),
  "retention_period" text CHECK ("retention_period" IS NULL OR btrim("retention_period") <> ''),
  "approval_id" text NOT NULL UNIQUE,
  "published_by" uuid NOT NULL,
  "published_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("section", "version"),
  CHECK ("section" <> 'retention' OR "retention_period" IS NOT NULL)
);

-- One audit row per publish, written in the same transaction: who published, who approved, which approval, and why.
CREATE TABLE IF NOT EXISTS "identity"."privacy_register_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "section" text NOT NULL,
  "version" integer NOT NULL,
  "actor_id" uuid NOT NULL,
  "approver_id" uuid NOT NULL,
  "approval_id" text NOT NULL,
  "reason" text NOT NULL CHECK (btrim("reason") <> ''),
  "at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY ("section", "version") REFERENCES "identity"."privacy_register" ("section", "version")
);

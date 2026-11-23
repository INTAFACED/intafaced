-- svc-academy · certificate designs, the revision an issued certificate prints, and stored issued-list exports
-- (AC-certificates-03)
-- Reversal: 20261112124542_certificate_designs.down.sql
--
-- Staff draft one design per published certificate. Every save is a new revision with who saved it and why; nothing is
-- overwritten. Activation is an explicit move: it refuses a revision with no signatory or a blank disclaimer. An active
-- design that is edited stays active, and its new revision is what certificates issued from then on print. An issued
-- certificate keeps the revision it was issued under (`cert_grants.design_revision`), so editing never changes one
-- already issued. An export of the issued list is a stored snapshot (CSV, time, maker, SHA-256), numbered
-- `certexport:<n>`, so a retry answers the export it made. A certificate never moves money.

CREATE TABLE IF NOT EXISTS "academy"."cert_design_revisions" (
  "cert_id"      text NOT NULL,
  "revision"     integer NOT NULL,
  "title"        text NOT NULL,
  "body"         text NOT NULL,
  "signatories"  jsonb NOT NULL,
  "disclaimer"   text,
  "language"     text NOT NULL,
  "size"         text NOT NULL,
  "effort_hours" text,
  "saved_by"     uuid NOT NULL,
  "reason"       text NOT NULL,
  "saved_at"     timestamptz NOT NULL,
  PRIMARY KEY ("cert_id", "revision"),
  CONSTRAINT "cert_design_revisions_revision_chk" CHECK ("revision" >= 1),
  CONSTRAINT "cert_design_revisions_size_chk" CHECK ("size" IN ('a4', 'letter')),
  CONSTRAINT "cert_design_revisions_signatories_chk" CHECK (jsonb_typeof("signatories") = 'array'),
  CONSTRAINT "cert_design_revisions_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);

CREATE TABLE IF NOT EXISTS "academy"."cert_designs" (
  "cert_id"         text PRIMARY KEY,
  "revision"        integer NOT NULL,
  "active_revision" integer,
  "activated_by"    uuid,
  "activated_at"    timestamptz,
  "activate_reason" text,
  FOREIGN KEY ("cert_id", "revision") REFERENCES "academy"."cert_design_revisions" ("cert_id", "revision"),
  FOREIGN KEY ("cert_id", "active_revision") REFERENCES "academy"."cert_design_revisions" ("cert_id", "revision")
);

ALTER TABLE "academy"."cert_grants" ADD COLUMN IF NOT EXISTS "design_revision" integer;

CREATE TABLE IF NOT EXISTS "academy"."cert_issued_exports" (
  "n"       integer PRIMARY KEY,
  "csv"     text NOT NULL,
  "sha256"  text NOT NULL,
  "rows"    integer NOT NULL,
  "made_by" uuid NOT NULL,
  "made_at" timestamptz NOT NULL,
  CONSTRAINT "cert_issued_exports_n_chk" CHECK ("n" >= 1),
  CONSTRAINT "cert_issued_exports_sha256_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

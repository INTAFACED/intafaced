-- KYB DOCUMENTS: THE FILES A BUSINESS UPLOADS FOR ITS VERIFICATION (I-kyc-compliance-22).
--
-- Bytes are stored encrypted (AES-256-GCM, key from the environment); the table holds ciphertext, a nonce and the
-- plaintext SHA-256, never the plaintext. One row per (application, document key, sha256), so the same bytes for the
-- same key sent twice are one row. The latest row for a key is the one the checklist shows. A row starts `provided`;
-- accepted and rejected come from compliance review (slice 25). The upload rules are owner data: no row means unset
-- and uploads refuse. Not money.

CREATE TABLE IF NOT EXISTS "pay"."kyb_upload_rules" (
  "singleton"     boolean PRIMARY KEY DEFAULT true CONSTRAINT "kyb_upload_rules_singleton" CHECK ("singleton"),
  "max_bytes"     integer NOT NULL CONSTRAINT "kyb_upload_rules_max_bytes_positive" CHECK ("max_bytes" >= 1),
  "content_types" text[] NOT NULL CONSTRAINT "kyb_upload_rules_content_types_set" CHECK (cardinality("content_types") >= 1),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "pay"."kyb_documents" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"              bigserial NOT NULL,
  "application_id"   uuid NOT NULL REFERENCES "pay"."kyb_applications"("id"),
  "document_key"     text NOT NULL CONSTRAINT "kyb_documents_key_format" CHECK ("document_key" ~ '^[a-z][a-z0-9_]{1,63}$'),
  "content_type"     text NOT NULL,
  "byte_length"      integer NOT NULL CHECK ("byte_length" >= 1),
  "sha256"           text NOT NULL CONSTRAINT "kyb_documents_sha256_format" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "ciphertext"       bytea NOT NULL,
  "nonce"            bytea NOT NULL CONSTRAINT "kyb_documents_nonce_len" CHECK (octet_length("nonce") = 12),
  "state"            text NOT NULL DEFAULT 'provided' CONSTRAINT "kyb_documents_state_known" CHECK ("state" IN ('provided', 'accepted', 'rejected')),
  "rejection_reason" text,
  "uploaded_by"      text NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kyb_documents_reason_only_when_rejected" CHECK (("state" = 'rejected') = ("rejection_reason" IS NOT NULL)),
  CONSTRAINT "kyb_documents_one_per_bytes" UNIQUE ("application_id", "document_key", "sha256")
);

CREATE UNIQUE INDEX IF NOT EXISTS "kyb_documents_seq_idx" ON "pay"."kyb_documents" ("seq");
CREATE INDEX IF NOT EXISTS "kyb_documents_application_key_idx" ON "pay"."kyb_documents" ("application_id", "document_key", "seq" DESC);

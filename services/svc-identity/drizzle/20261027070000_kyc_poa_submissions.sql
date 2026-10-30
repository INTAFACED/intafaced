-- svc-identity · proof of address (I-kyc-compliance-11, J-identity-08 #5). One row per document a person sends: the
-- owner-listed type, the country it is from, the date issued as the person entered it, and the vault id of the file
-- (kyc_documents, sealed there). `country_mismatch` flags a document whose country differs from the residence on the
-- approved level, for the reviewer. No address text is stored here. Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."kyc_poa_submissions" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "document_id"      uuid NOT NULL REFERENCES "identity"."kyc_documents" ("id") ON DELETE CASCADE,
  "type"             text NOT NULL CHECK ("type" ~ '^[a-z][a-z0-9_]{1,63}$'),
  "country"          text NOT NULL CHECK ("country" ~ '^[A-Z]{2}$'),
  "issued_on"        date NOT NULL,
  "country_mismatch" boolean NOT NULL,
  -- The file's SHA-256, so the same document sent again returns its pending submission instead of a second one.
  "file_sha256"      text NOT NULL CHECK ("file_sha256" ~ '^[0-9a-f]{64}$'),
  "status"           text NOT NULL DEFAULT 'submitted' CHECK ("status" IN ('submitted', 'accepted', 'rejected')),
  "created_at"       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kyc_poa_submissions_user_idx" ON "identity"."kyc_poa_submissions" ("user_id", "created_at" DESC);
-- One pending submission per document: two identical sends at once insert one row (the other finds it).
CREATE UNIQUE INDEX IF NOT EXISTS "kyc_poa_submissions_pending_once" ON "identity"."kyc_poa_submissions"
  ("user_id", "type", "country", "issued_on", "file_sha256") WHERE "status" = 'submitted';

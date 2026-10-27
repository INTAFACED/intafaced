-- svc-identity · guided verification drafts (I-kyc-compliance-08, J-identity-08 #2). One draft per person: the level
-- asked for, the step to resume at, and the fields entered so far, sealed under the KYC document key (AES-256-GCM, the
-- same key as kyc_documents); never a plaintext personal field here or in kyc_records. The ID photo is a kyc_documents
-- row, referred to inside the sealed fields. A save moves the version on by one; `last_save` is a keyed hash of the
-- last save (step, version it was made from, fields), so the same save sent twice returns the draft instead of refusing.
-- `record_id` is set when the draft is sent. Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."kyc_profile_drafts" (
  "user_id"    uuid PRIMARY KEY REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "tier"       text NOT NULL CHECK ("tier" IN ('basic', 'full', 'institutional')),
  "step"       smallint NOT NULL CHECK ("step" BETWEEN 1 AND 6),
  "version"    integer NOT NULL CHECK ("version" >= 1),
  "ciphertext" bytea NOT NULL,
  "nonce"      bytea NOT NULL,
  "key_id"     text NOT NULL DEFAULT 'v1',
  "last_save"  text,
  "record_id"  uuid REFERENCES "identity"."kyc_records" ("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

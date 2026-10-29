-- svc-identity · selfie (I-kyc-compliance-09, J-identity-08 #3). One row per selfie a person takes: the vault id of the
-- captured frame (kyc_documents, sealed there), whether it came from this device or a phone hand-off, and its review
-- state. The face match (`vendor.kyc`) is not connected, so a selfie stays `provided` until a person compares it with
-- the ID photo; the row keeps who decided it and when. A hand-off link is stored only as the SHA-256 of its token, with its expiry and the moment it was used.
-- Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."kyc_selfies" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL REFERENCES "identity"."kyc_documents" ("id") ON DELETE CASCADE,
  "via"         text NOT NULL CHECK ("via" IN ('this_device', 'handoff')),
  "status"      text NOT NULL DEFAULT 'provided' CHECK ("status" IN ('provided', 'accepted', 'rejected')),
  "decided_by"  uuid,
  "decided_at"  timestamptz,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CHECK (("status" = 'provided') = ("decided_at" IS NULL))
);
CREATE INDEX IF NOT EXISTS "kyc_selfies_user_idx" ON "identity"."kyc_selfies" ("user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "identity"."kyc_selfie_handoffs" (
  "token_sha256" text PRIMARY KEY CHECK ("token_sha256" ~ '^[0-9a-f]{64}$'),
  "user_id"      uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "expires_at"   timestamptz NOT NULL,
  "used_at"      timestamptz,
  "selfie_id"    uuid REFERENCES "identity"."kyc_selfies" ("id") ON DELETE SET NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kyc_selfie_handoffs_user_idx" ON "identity"."kyc_selfie_handoffs" ("user_id", "created_at" DESC);

-- svc-identity · one-time signed-out password reset proofs (D-38, S13).
-- Reversal: 0031_password_reset_proofs.down.sql.
--
-- The code itself is never stored. `code_hash` is the SHA-256 hex of a
-- high-entropy token handed only to the mail port. A proof is single-use:
-- completing a reset stamps every still-open proof for that user.
-- No plaintext password, no session, no email copy on this table.
CREATE TABLE IF NOT EXISTS "identity"."password_reset_proofs" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "code_hash"   text NOT NULL CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  "expires_at"  timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_proofs_code_hash_idx"
  ON "identity"."password_reset_proofs" ("code_hash");

CREATE INDEX IF NOT EXISTS "password_reset_proofs_user_open_idx"
  ON "identity"."password_reset_proofs" ("user_id")
  WHERE "consumed_at" IS NULL;

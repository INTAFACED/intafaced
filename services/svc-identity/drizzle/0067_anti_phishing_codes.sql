-- Anti-phishing code (I-signin-sessions-25). One code per account, shown back to its owner, so it is
-- encrypted (AES-256-GCM, a key derived from IDENTITY_TOTP_SECRET_KEY), never hashed and never plaintext.
-- The audit row names the change and the session, never the code.
-- Reversal: 0067_anti_phishing_codes.down.sql

CREATE TABLE IF NOT EXISTS "identity"."anti_phishing_codes" (
  "user_id" uuid PRIMARY KEY REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "ciphertext" bytea NOT NULL,
  "nonce" bytea NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS "identity"."anti_phishing_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "session_id" text NOT NULL,
  "action" text NOT NULL CHECK ("action" IN ('set', 'cleared')),
  "at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "anti_phishing_audit_user_idx" ON "identity"."anti_phishing_audit" ("user_id", "at" DESC);

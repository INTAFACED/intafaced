-- svc-identity · email and phone change proofs (IDENTACCT).
-- Reversal: 0043_contact_change.down.sql.
--
-- The code is never stored. `code_hash` is the SHA-256 hex of a high-entropy
-- token handed only to the mail or phone port. Five failed checks lock the
-- proof (`attempts`). A verified phone lives on `user_phones` and is not a
-- sign-in factor. The audit table has no code and no hash.
CREATE TABLE IF NOT EXISTS "identity"."contact_change_proofs" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "channel"     text NOT NULL CHECK ("channel" IN ('email', 'phone')),
  "target"      text NOT NULL,
  "code_hash"   text NOT NULL CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  "attempts"    integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0 AND "attempts" <= 5),
  "expires_at"  timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "contact_change_proofs_user_open_idx"
  ON "identity"."contact_change_proofs" ("user_id", "channel", "created_at")
  WHERE "consumed_at" IS NULL;

CREATE TABLE IF NOT EXISTS "identity"."contact_change_audit" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "session_id"  uuid NOT NULL,
  "channel"     text NOT NULL CHECK ("channel" IN ('email', 'phone')),
  "event"       text NOT NULL CHECK ("event" IN ('begin', 'confirm', 'remove')),
  "old_target"  text,
  "new_target"  text,
  "old_notice"  text CHECK ("old_notice" IS NULL OR "old_notice" IN ('sent', 'failed', 'unsent')),
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "contact_change_audit_user_idx"
  ON "identity"."contact_change_audit" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "identity"."user_phones" (
  "user_id"     uuid PRIMARY KEY REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "phone"       text NOT NULL CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$'),
  "verified_at" timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_phones_phone_idx"
  ON "identity"."user_phones" ("phone");

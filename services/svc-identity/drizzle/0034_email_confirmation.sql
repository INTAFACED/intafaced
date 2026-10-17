-- svc-identity · email confirmation (next free identity migration after 0033).
-- Reversal: 0034_email_confirmation.down.sql.
--
-- `email_verified_at` is null until a single-use proof for the current address
-- is confirmed. Changing the email clears the stamp and consumes open proofs.
-- The mailed token is never stored: `code_hash` is its SHA-256. The audit
-- table has no token, code, or link column.

ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamptz;

CREATE OR REPLACE FUNCTION "identity"."clear_email_verified_on_email_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email_verified_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "users_email_change_clears_verification" ON "identity"."users";
CREATE TRIGGER "users_email_change_clears_verification"
  BEFORE UPDATE OF email ON "identity"."users"
  FOR EACH ROW
  EXECUTE FUNCTION "identity"."clear_email_verified_on_email_change"();

CREATE TABLE IF NOT EXISTS "identity"."email_confirmation_proofs" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "code_hash"   text NOT NULL CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  "email_hash"  text NOT NULL CHECK ("email_hash" ~ '^[0-9a-f]{64}$'),
  "expires_at"  timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_confirmation_proofs_code_hash_idx"
  ON "identity"."email_confirmation_proofs" ("code_hash");

CREATE INDEX IF NOT EXISTS "email_confirmation_proofs_user_open_idx"
  ON "identity"."email_confirmation_proofs" ("user_id")
  WHERE "consumed_at" IS NULL;

CREATE TABLE IF NOT EXISTS "identity"."email_confirmation_attempts" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "email_confirmation_attempts_user_created_idx"
  ON "identity"."email_confirmation_attempts" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "identity"."email_confirmation_audit" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "event"      text NOT NULL,
  "reason"     text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "email_confirmation_audit_event_ck" CHECK ("event" IN ('requested', 'confirmed', 'refused')),
  CONSTRAINT "email_confirmation_audit_reason_ck" CHECK ("reason" IN ('issued', 'confirmed', 'expired', 'reused', 'mismatch'))
);

CREATE INDEX IF NOT EXISTS "email_confirmation_audit_user_idx"
  ON "identity"."email_confirmation_audit" ("user_id", "created_at");

CREATE OR REPLACE FUNCTION "identity"."consume_email_proofs_on_email_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE "identity"."email_confirmation_proofs"
    SET "consumed_at" = now()
    WHERE "user_id" = NEW.id AND "consumed_at" IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "users_email_change_consumes_proofs" ON "identity"."users";
CREATE TRIGGER "users_email_change_consumes_proofs"
  AFTER UPDATE OF email ON "identity"."users"
  FOR EACH ROW
  EXECUTE FUNCTION "identity"."consume_email_proofs_on_email_change"();

-- Payee search by exact email or phone (BANKPAY item 15).
--
-- Finding someone by email or phone is opt-in. Both consent flags default
-- false, so an account is not discoverable until that person turns it on.
-- The phone number is the account's own; search returns a handle, never the
-- phone or the email. The audit records the consent change, never the number.
--
-- Reversal: 0037_payee_search.down.sql

ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "phone" text;
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "phone_verified_at" timestamptz;
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "payee_email_consent" boolean NOT NULL DEFAULT false;
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "payee_phone_consent" boolean NOT NULL DEFAULT false;

ALTER TABLE "identity"."users" DROP CONSTRAINT IF EXISTS "users_phone_e164_ck";
ALTER TABLE "identity"."users"
  ADD CONSTRAINT "users_phone_e164_ck" CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{7,14}$');

CREATE TABLE IF NOT EXISTS "identity"."payee_search_audit" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        uuid NOT NULL REFERENCES "identity"."users"("id"),
  "event"          text NOT NULL,
  "email_consent"  boolean,
  "phone_consent"  boolean,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payee_search_audit_event_ck" CHECK ("event" IN ('consent', 'phone_set', 'phone_cleared'))
);

CREATE INDEX IF NOT EXISTS "payee_search_audit_user_idx"
  ON "identity"."payee_search_audit" ("user_id", "created_at");

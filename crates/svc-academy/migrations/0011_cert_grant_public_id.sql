-- svc-academy · public certificate id, status, holder consent
-- Reversal: 0011_cert_grant_public_id.down.sql
--
-- public_id is 128 random bits from pgcrypto (gen_random_bytes), including
-- the backfill of every existing grant. It is not derived from user_id or
-- from the cert:<account>:<certificate> idempotency key.
-- Holder name is null until the holder consents. Status starts valid.

ALTER TABLE "academy"."cert_grants"
  ADD COLUMN IF NOT EXISTS "public_id" text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex');

DO $$ BEGIN
  ALTER TABLE "academy"."cert_grants"
    ADD CONSTRAINT "cert_grants_public_id_uq" UNIQUE ("public_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "academy"."cert_grants"
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'valid';

DO $$ BEGIN
  ALTER TABLE "academy"."cert_grants"
    ADD CONSTRAINT "cert_grants_status_chk" CHECK ("status" IN ('valid', 'revoked'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "academy"."cert_grants"
  ADD COLUMN IF NOT EXISTS "holder_name" text;

ALTER TABLE "academy"."cert_grants"
  ADD COLUMN IF NOT EXISTS "holder_consent_at" timestamptz;

DO $$ BEGIN
  ALTER TABLE "academy"."cert_grants"
    ADD CONSTRAINT "cert_grants_holder_consent_chk" CHECK (
      ("holder_name" IS NULL AND "holder_consent_at" IS NULL)
      OR ("holder_name" IS NOT NULL AND "holder_consent_at" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "academy"."cert_holder_name_requests" (
  "user_id"            uuid NOT NULL,
  "client_request_id"  text NOT NULL,
  "public_id"          text NOT NULL,
  "holder_name"        text,
  "consent_at"         timestamptz,
  PRIMARY KEY ("user_id", "client_request_id")
);

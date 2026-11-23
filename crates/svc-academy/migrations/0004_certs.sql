-- svc-academy · certifications Stage-1 (progress + grants — NO XP / NO PERKS / NO PAY)
-- Reversal: 0004_certs.down.sql
--
-- Cert definitions are code-seeded (see certs/catalog.ts). This migration only
-- stores durable user progress. XP emit and rank perks are Stage-2.

CREATE TABLE IF NOT EXISTS "academy"."cert_enrollments" (
  "user_id"      uuid NOT NULL,
  "path_slug"    text NOT NULL,
  "enrolled_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "path_slug")
);

CREATE TABLE IF NOT EXISTS "academy"."cert_item_completions" (
  "user_id"       uuid NOT NULL,
  "item_slug"     text NOT NULL,
  "completed_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "item_slug")
);

CREATE INDEX IF NOT EXISTS "cert_item_completions_user_idx"
  ON "academy"."cert_item_completions" ("user_id", "completed_at" DESC);

CREATE TABLE IF NOT EXISTS "academy"."cert_grants" (
  "user_id"           uuid NOT NULL,
  "cert_id"           text NOT NULL,
  "granted_at"        timestamptz NOT NULL DEFAULT now(),
  "idempotency_key"   text NOT NULL,
  PRIMARY KEY ("user_id", "cert_id"),
  CONSTRAINT "cert_grants_idempotency_uq" UNIQUE ("idempotency_key")
);

CREATE INDEX IF NOT EXISTS "cert_grants_user_idx"
  ON "academy"."cert_grants" ("user_id", "granted_at" DESC);

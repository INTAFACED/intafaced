-- svc-support · desk staff roles and idempotent assignment commands
-- Reversal: 0012_support_staff.down.sql
--
-- Staff are people who hold support:ops. The role says whether they may
-- assign a ticket to someone else. Commands remember an idempotency key so a
-- retried assign does not write a second trail row.

CREATE TABLE IF NOT EXISTS "support"."staff" (
  "user_id" text PRIMARY KEY,
  "role" text NOT NULL CHECK ("role" IN ('agent', 'lead')),
  "appointed_by" text NOT NULL,
  "appointed_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "support"."desk_commands" (
  "idempotency_key" text PRIMARY KEY,
  "fingerprint" text NOT NULL,
  "result" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- M-adv-payments-core-01: saved views on the payments list, and the audit of every unmasked payment detail.
-- Reversal: 20261029210751_pay_payment_views_unmask.down.sql
--
-- payment_views: one person's (private) or the whole team's (shared) set of list filters and visible columns. The
-- filters are the list's own query keys and the columns come from the service's allowlist, both checked in
-- merchant-ops/payment-views.ts before a row is written. A name is unique per person per business, which is what makes
-- create idempotent on (person, name). No money is stored here.
--
-- payment_unmask_reads: one append-only row per clear value shown (who, which payment, which field, and why). The
-- clear value itself is never copied into it.

CREATE TABLE IF NOT EXISTS "pay"."payment_views" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "owner_user_id" text NOT NULL,
  "name" text NOT NULL,
  "visibility" text NOT NULL,
  "filters" jsonb NOT NULL,
  "columns" text[] NOT NULL,
  "revision" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_views_visibility_known" CHECK ("visibility" IN ('private', 'shared')),
  CONSTRAINT "payment_views_name_plain" CHECK (length(btrim("name")) BETWEEN 1 AND 60),
  CONSTRAINT "payment_views_columns_some" CHECK (cardinality("columns") BETWEEN 1 AND 12)
);

CREATE UNIQUE INDEX IF NOT EXISTS "payment_views_owner_name"
  ON "pay"."payment_views" ("merchant_id", "owner_user_id", lower("name"));

CREATE INDEX IF NOT EXISTS "payment_views_merchant"
  ON "pay"."payment_views" ("merchant_id", "visibility", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "pay"."payment_unmask_reads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "payment_id" uuid NOT NULL REFERENCES "pay"."payments"("id"),
  "field" text NOT NULL,
  "actor_id" text NOT NULL,
  "actor_role" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_unmask_reads_field_known" CHECK ("field" IN ('customerEmail')),
  CONSTRAINT "payment_unmask_reads_reason_given" CHECK (length(btrim("reason")) BETWEEN 8 AND 500)
);

CREATE INDEX IF NOT EXISTS "payment_unmask_reads_merchant"
  ON "pay"."payment_unmask_reads" ("merchant_id", "created_at" DESC, "id" DESC);

-- W6 prelive: stop rechecking a resolve-absent row forever, and record a
-- two-founder booking of a late fill. Reversal: 0086_pay_conversion_late_fill_book.down.sql
--
-- late_fill_check_final_at is set when the technical horizon has passed
-- (7 days after the absent-resolve confirmation, or placing_at when that
-- confirmation is missing). The sweep does not call the venue after that.
-- late_fill_next_check_at is the jittered backoff. A venue error leaves both
-- untouched. Neither column is a quote TTL.
--
-- conversion_late_fill_books stores no amount. The hash binds the audit row
-- and the venue evidence the first founder fetched. Confirm fetches the venue
-- again and posts only when that evidence still hashes the same.

ALTER TABLE "pay"."conversion_orders"
  ADD COLUMN IF NOT EXISTS "late_fill_check_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "pay"."conversion_orders"
  ADD COLUMN IF NOT EXISTS "late_fill_next_check_at" timestamptz;

ALTER TABLE "pay"."conversion_orders"
  ADD COLUMN IF NOT EXISTS "late_fill_check_final_at" timestamptz;

ALTER TABLE "pay"."conversion_orders"
  DROP CONSTRAINT IF EXISTS "conversion_orders_late_fill_checks";

ALTER TABLE "pay"."conversion_orders"
  ADD CONSTRAINT "conversion_orders_late_fill_checks" CHECK ("late_fill_check_count" >= 0);

CREATE INDEX IF NOT EXISTS "conversion_orders_late_fill_due_idx"
  ON "pay"."conversion_orders" ("late_fill_next_check_at" NULLS FIRST, "id")
  WHERE "failure_code" = 'pay.conversion_resolve_absent' AND "late_fill_check_final_at" IS NULL;

CREATE TABLE IF NOT EXISTS "pay"."conversion_late_fill_books" (
  "request_id"     uuid PRIMARY KEY,
  "audit_id"       uuid NOT NULL REFERENCES "pay"."conversion_audit"("id"),
  "conversion_id"  uuid NOT NULL REFERENCES "pay"."conversion_orders"("id"),
  "change_hash"    text NOT NULL,
  "reason"         text NOT NULL,
  "evidence"       jsonb NOT NULL,
  "proposed_by"    text NOT NULL,
  "status"         text NOT NULL,
  "funding"        text,
  "confirmed_by"   text,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "decided_at"     timestamptz,
  CONSTRAINT "conversion_late_fill_book_status" CHECK ("status" IN ('pending', 'confirmed', 'rejected')),
  CONSTRAINT "conversion_late_fill_book_hash" CHECK ("change_hash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "conversion_late_fill_book_reason" CHECK (length(btrim("reason")) > 0 AND length("reason") <= 500),
  CONSTRAINT "conversion_late_fill_book_actor" CHECK (length(btrim("proposed_by")) > 0),
  CONSTRAINT "conversion_late_fill_book_funding" CHECK ("funding" IS NULL OR "funding" IN ('merchant', 'inventory')),
  CONSTRAINT "conversion_late_fill_book_evidence" CHECK (jsonb_typeof("evidence") = 'object')
);

-- One open or confirmed booking per audit. A rejection can be replaced.
CREATE UNIQUE INDEX IF NOT EXISTS "conversion_late_fill_books_open_idx"
  ON "pay"."conversion_late_fill_books" ("audit_id")
  WHERE "status" IN ('pending', 'confirmed');

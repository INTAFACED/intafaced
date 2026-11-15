-- J-developer-10 (DV-webhooks-01..03): receive webhooks and verify them.
-- Reversal: the .down.sql beside this file.
--
-- Not money: endpoint configuration and the delivery journal only. Nothing here holds a balance or moves value.
--
--  · event_types: what an endpoint subscribed to. Every endpoint stored before this change keeps every public type,
--    which is what it received until now.
--  · previous_signing_secret / previous_secret_until: a rolled secret's overlap. While it lasts each delivery carries
--    two signatures; after it, only the new secret signs. Both are set together or neither is.
--  · resend_request_id: the resend a person asked for, cleared by the attempt that answers it.
--  · merchant_webhook_attempts: one row per attempt (outcome, response code, time taken). A resend request id names at
--    most one attempt per delivery.
--  · merchant_webhook_recoveries: "recover missed events" requests, idempotent on the request id.

ALTER TABLE "pay"."merchant_webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "event_types" text[] NOT NULL
    DEFAULT ARRAY['payment.authorized', 'payment.captured', 'payment.refunded', 'payment.failed']::text[];
ALTER TABLE "pay"."merchant_webhook_endpoints" DROP CONSTRAINT IF EXISTS "merchant_webhook_endpoints_event_types_ck";
ALTER TABLE "pay"."merchant_webhook_endpoints" ADD CONSTRAINT "merchant_webhook_endpoints_event_types_ck"
  CHECK (
    cardinality("event_types") > 0
    AND "event_types" <@ ARRAY['payment.authorized', 'payment.captured', 'payment.refunded', 'payment.failed']::text[]
  );

ALTER TABLE "pay"."merchant_webhook_endpoints" ADD COLUMN IF NOT EXISTS "previous_signing_secret" text;
ALTER TABLE "pay"."merchant_webhook_endpoints" ADD COLUMN IF NOT EXISTS "previous_secret_until" timestamptz;
ALTER TABLE "pay"."merchant_webhook_endpoints" DROP CONSTRAINT IF EXISTS "merchant_webhook_endpoints_overlap_pair_ck";
ALTER TABLE "pay"."merchant_webhook_endpoints" ADD CONSTRAINT "merchant_webhook_endpoints_overlap_pair_ck"
  CHECK (("previous_signing_secret" IS NULL) = ("previous_secret_until" IS NULL));

ALTER TABLE "pay"."merchant_webhook_rotations" ADD COLUMN IF NOT EXISTS "overlap_seconds" integer NOT NULL DEFAULT 0;
ALTER TABLE "pay"."merchant_webhook_rotations" DROP CONSTRAINT IF EXISTS "merchant_webhook_rotations_overlap_ck";
ALTER TABLE "pay"."merchant_webhook_rotations" ADD CONSTRAINT "merchant_webhook_rotations_overlap_ck" CHECK ("overlap_seconds" >= 0);

ALTER TABLE "pay"."merchant_webhook_deliveries" ADD COLUMN IF NOT EXISTS "resend_request_id" uuid;

CREATE TABLE IF NOT EXISTS "pay"."merchant_webhook_attempts" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "delivery_id"       uuid NOT NULL REFERENCES "pay"."merchant_webhook_deliveries"("id") ON DELETE CASCADE,
  "merchant_id"       uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "attempt_no"        integer NOT NULL CONSTRAINT "merchant_webhook_attempts_no_ck" CHECK ("attempt_no" > 0),
  "started_at"        timestamptz NOT NULL,
  "finished_at"       timestamptz NOT NULL,
  "outcome"           text NOT NULL CONSTRAINT "merchant_webhook_attempts_outcome_ck" CHECK ("outcome" IN ('delivered', 'failed', 'unknown')),
  "status_code"       integer,
  "error"             text,
  "resend_request_id" uuid,
  CONSTRAINT "merchant_webhook_attempts_no_uq" UNIQUE ("delivery_id", "attempt_no")
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_webhook_attempts_resend_uq"
  ON "pay"."merchant_webhook_attempts" ("delivery_id", "resend_request_id")
  WHERE "resend_request_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "merchant_webhook_attempts_merchant_idx"
  ON "pay"."merchant_webhook_attempts" ("merchant_id", "delivery_id");

CREATE TABLE IF NOT EXISTS "pay"."merchant_webhook_recoveries" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"   uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id"    uuid NOT NULL,
  "endpoint_id"   uuid NOT NULL,
  "since"         timestamptz NOT NULL,
  "queued"        integer NOT NULL CONSTRAINT "merchant_webhook_recoveries_queued_ck" CHECK ("queued" >= 0),
  "requested_by"  text NOT NULL CONSTRAINT "merchant_webhook_recoveries_by_not_blank" CHECK (length(btrim("requested_by")) > 0),
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "merchant_webhook_recoveries_request_uq" UNIQUE ("merchant_id", "request_id")
);

CREATE INDEX IF NOT EXISTS "merchant_webhook_recoveries_window_idx"
  ON "pay"."merchant_webhook_recoveries" ("merchant_id", "created_at" DESC);

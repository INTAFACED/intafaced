-- Merchant portal: export kinds, file metadata, and webhook retry/rotate idempotency.
--
-- Activity itself is a read of merchant-visible rows (payments, team, KYB,
-- disputes, exports, approvals, webhook endpoints and deliveries). Founder
-- control_audit is not copied here.
--
-- New export kinds are names only. No fee, cap, or retention number is stored.
-- A ready file expires only when an operator sets PAY export TTL or a merchant
-- calls the expire action.

ALTER TABLE "pay"."merchant_export_jobs" DROP CONSTRAINT IF EXISTS "merchant_export_jobs_kind_ck";
ALTER TABLE "pay"."merchant_export_jobs" ADD CONSTRAINT "merchant_export_jobs_kind_ck"
  CHECK ("kind" IN ('payments', 'settlements', 'payouts', 'refunds', 'ledger_statement', 'disputes', 'fees'));

ALTER TABLE "pay"."merchant_export_jobs" DROP CONSTRAINT IF EXISTS "merchant_export_jobs_status_ck";
ALTER TABLE "pay"."merchant_export_jobs" ADD CONSTRAINT "merchant_export_jobs_status_ck"
  CHECK ("status" IN ('queued', 'running', 'ready', 'failed', 'expired'));

ALTER TABLE "pay"."merchant_export_jobs" ADD COLUMN IF NOT EXISTS "generated_at" timestamptz;
ALTER TABLE "pay"."merchant_export_jobs" ADD COLUMN IF NOT EXISTS "columns" jsonb;

-- One merchant retry request. The row is the idempotency key. It does not store
-- a payload, a response body, or a signing secret.
CREATE TABLE IF NOT EXISTS "pay"."merchant_webhook_retries" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"   uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id"    uuid NOT NULL,
  "delivery_id"   uuid NOT NULL,
  "requested_by"  text NOT NULL CONSTRAINT "merchant_webhook_retries_by_not_blank" CHECK (length(btrim("requested_by")) > 0),
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "merchant_webhook_retries_request_uq" UNIQUE ("merchant_id", "request_id")
);

CREATE INDEX IF NOT EXISTS "merchant_webhook_retries_window_idx"
  ON "pay"."merchant_webhook_retries" ("merchant_id", "created_at" DESC);

-- Rotate idempotency. The new secret is not stored here; the endpoint row keeps
-- the signing secret the delivery worker already uses, and the API reveals it once.
CREATE TABLE IF NOT EXISTS "pay"."merchant_webhook_rotations" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"   uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "endpoint_id"   uuid NOT NULL,
  "request_id"    uuid NOT NULL,
  "requested_by"  text NOT NULL CONSTRAINT "merchant_webhook_rotations_by_not_blank" CHECK (length(btrim("requested_by")) > 0),
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "merchant_webhook_rotations_request_uq" UNIQUE ("merchant_id", "request_id")
);

CREATE INDEX IF NOT EXISTS "merchant_webhook_rotations_endpoint_idx"
  ON "pay"."merchant_webhook_rotations" ("merchant_id", "endpoint_id");

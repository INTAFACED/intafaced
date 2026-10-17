-- W15 merchant operations: asynchronous CSV export jobs.
--
-- A job is requested by one team member for one merchant and generated on the
-- server from that merchant's rows only. The finished file is stored with the
-- job (`content`), so a download never regenerates (and never widens) a report.
-- `request_id` makes a retried request return the same job instead of a second one.

CREATE TABLE IF NOT EXISTS "pay"."merchant_export_jobs" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"   uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id"    uuid NOT NULL,
  "requested_by"  text NOT NULL CONSTRAINT "merchant_export_jobs_by_not_blank" CHECK (length(btrim("requested_by")) > 0),
  "kind"          text NOT NULL CONSTRAINT "merchant_export_jobs_kind_ck" CHECK ("kind" IN ('payments', 'settlements', 'payouts')),
  "filters"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status"        text NOT NULL DEFAULT 'queued' CONSTRAINT "merchant_export_jobs_status_ck" CHECK ("status" IN ('queued', 'running', 'ready', 'failed')),
  "failure_code"  text,
  "file_name"     text,
  "content_type"  text,
  "content"       text,
  "size_bytes"    bigint,
  "row_count"     integer,
  "sha256"        text,
  "as_of"         timestamptz,
  "expires_at"    timestamptz,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  "completed_at"  timestamptz,
  CONSTRAINT "merchant_export_jobs_ready_has_file_ck" CHECK ("status" <> 'ready' OR ("content" IS NOT NULL AND "row_count" IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_export_jobs_request_idx"
  ON "pay"."merchant_export_jobs" ("merchant_id", "request_id");
CREATE INDEX IF NOT EXISTS "merchant_export_jobs_merchant_idx"
  ON "pay"."merchant_export_jobs" ("merchant_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "merchant_export_jobs_queue_idx"
  ON "pay"."merchant_export_jobs" ("status", "created_at") WHERE "status" IN ('queued', 'running');

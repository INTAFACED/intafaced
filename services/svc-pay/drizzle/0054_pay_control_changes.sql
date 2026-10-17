-- W1 MERCHANT CONTROL ROOM (5/5): dual-control change requests.
--
-- A tier, caps, pricing or reserve change is SUBMITTED by one founder and only
-- takes effect when a DIFFERENT founder confirms it. Both are authenticated
-- founder sessions; a typed-in second name is not accepted.

CREATE TABLE IF NOT EXISTS "pay"."control_changes" (
  "request_id"       uuid PRIMARY KEY,
  "seq"              bigserial NOT NULL,
  "scope"            text NOT NULL CONSTRAINT "control_changes_scope_known" CHECK ("scope" IN ('merchant', 'tier', 'pricing')),
  "scope_id"         text NOT NULL,
  "merchant_id"      uuid,
  "change"           jsonb NOT NULL,
  "change_hash"      text NOT NULL,
  "reason"           text NOT NULL CONSTRAINT "control_changes_reason_not_blank" CHECK (length(btrim("reason")) > 0),
  "expected_version" bigint NOT NULL,
  "maker_id"         text NOT NULL CONSTRAINT "control_changes_maker_not_blank" CHECK (length(btrim("maker_id")) > 0),
  "status"           text NOT NULL DEFAULT 'pending'
    CONSTRAINT "control_changes_status_known" CHECK ("status" IN ('pending', 'applied', 'rejected', 'conflict')),
  "checker_id"       text,
  "checker_reason"   text,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "decided_at"       timestamptz,
  CONSTRAINT "control_changes_maker_not_checker" CHECK ("checker_id" IS NULL OR "checker_id" <> "maker_id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "control_changes_seq_idx" ON "pay"."control_changes" ("seq");
CREATE INDEX IF NOT EXISTS "control_changes_pending_idx" ON "pay"."control_changes" ("status", "seq");

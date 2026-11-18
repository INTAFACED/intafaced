-- svc-support · response targets (SP-sla-01; J-support-public-10 #1, J-support-public-13 #4). Reversal: the .down.sql of
-- the same name.
--
-- One row holds the desk's first-reply target in minutes and whether it is on. The target is NULL and the policy off until
-- a lead sets them: nothing is seeded, and on with no target is refused (`support.sla_targets_unset`). Every change is
-- appended to the log under a business key (`support.sla_policy:r<revision>`) with who made it and why; the log refuses
-- update and delete. While the policy is on, each new request starts one first-reply clock, keyed by ticket and metric.

CREATE TABLE IF NOT EXISTS "support"."sla_policy" (
  "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
  "first_reply_minutes" integer CHECK ("first_reply_minutes" IS NULL OR "first_reply_minutes" >= 1),
  "active" boolean NOT NULL DEFAULT false,
  "revision" integer NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "updated_by" text,
  "updated_at" timestamptz,
  CHECK (NOT "active" OR "first_reply_minutes" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "support"."sla_policy_log" (
  "key" text PRIMARY KEY,
  "fingerprint" text NOT NULL,
  "revision_after" integer NOT NULL UNIQUE CHECK ("revision_after" >= 1),
  "before" jsonb NOT NULL,
  "after" jsonb NOT NULL,
  "set_by" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "set_at" timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION "support"."sla_policy_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.sla_policy_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "sla_policy_log_append_only_trg" ON "support"."sla_policy_log";
CREATE TRIGGER "sla_policy_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."sla_policy_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."sla_policy_log_append_only"();

CREATE TABLE IF NOT EXISTS "support"."sla_clocks" (
  "ticket_id" uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE CASCADE,
  "metric" text NOT NULL CHECK ("metric" IN ('first_reply')),
  "target_minutes" integer NOT NULL CHECK ("target_minutes" >= 1),
  "started_at" timestamptz NOT NULL,
  "due_at" timestamptz NOT NULL CHECK ("due_at" > "started_at"),
  "policy_revision" integer NOT NULL CHECK ("policy_revision" >= 1),
  PRIMARY KEY ("ticket_id", "metric")
);

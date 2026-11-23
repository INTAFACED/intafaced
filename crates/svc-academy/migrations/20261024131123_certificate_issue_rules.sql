-- svc-academy · how a certificate is issued (AC-certificates-02)
-- Reversal: 20261024131123_certificate_issue_rules.down.sql
--
-- One issue rule per certificate: `manual` (the learner claims it once every required item is recorded, which is what a
-- certificate with no rule row does), `automatic` (issued when the last required item is recorded) or `delayed` (issued
-- once the owner's delay has passed after that). A delay belongs to `delayed` only. Every change is a new revision with
-- a history row naming the operator and the reason. A delayed certificate waits as one pending row per learner and
-- certificate, with the time it is due; the issue sweep and the learner's own reads issue it once due and then drop the
-- row. A certificate never moves money.

CREATE TABLE IF NOT EXISTS "academy"."cert_issue_rules" (
  "cert_id"        text PRIMARY KEY,
  "mode"           text NOT NULL,
  "delay_minutes"  integer,
  "revision"       integer NOT NULL,
  "updated_by"     uuid NOT NULL,
  "updated_at"     timestamptz NOT NULL,
  CONSTRAINT "cert_issue_rules_mode_chk" CHECK ("mode" IN ('manual', 'automatic', 'delayed')),
  CONSTRAINT "cert_issue_rules_delay_chk" CHECK (("mode" = 'delayed') = ("delay_minutes" IS NOT NULL)),
  CONSTRAINT "cert_issue_rules_delay_range_chk" CHECK ("delay_minutes" IS NULL OR "delay_minutes" BETWEEN 1 AND 525600),
  CONSTRAINT "cert_issue_rules_revision_chk" CHECK ("revision" > 0)
);

CREATE TABLE IF NOT EXISTS "academy"."cert_issue_rule_events" (
  "cert_id"        text NOT NULL,
  "revision"       integer NOT NULL,
  "mode"           text NOT NULL,
  "delay_minutes"  integer,
  "actor"          uuid NOT NULL,
  "reason"         text NOT NULL,
  "at"             timestamptz NOT NULL,
  PRIMARY KEY ("cert_id", "revision")
);

CREATE TABLE IF NOT EXISTS "academy"."cert_issue_pending" (
  "user_id"        uuid NOT NULL,
  "cert_id"        text NOT NULL,
  "due_at"         timestamptz NOT NULL,
  "created_at"     timestamptz NOT NULL,
  PRIMARY KEY ("user_id", "cert_id")
);

CREATE INDEX IF NOT EXISTS "cert_issue_pending_due_idx" ON "academy"."cert_issue_pending" ("due_at");

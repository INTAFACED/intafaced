-- svc-academy · revoking an issued certificate (AC-certificates-03)
-- Reversal: 20261024141500_certificate_revocations.down.sql
--
-- Staff revoke one issued certificate by its public code under two-person approval. The grant keeps its row and turns
-- `revoked`, so the public check says revoked and the learner cannot claim it again; this table records once who
-- proposed it, who approved it, why and when. A repeat revoke answers with the first record. A certificate never moves
-- money. Also: the issue rule history gets the mode check its rule table has.

CREATE TABLE IF NOT EXISTS "academy"."cert_revocations" (
  "public_id"   text PRIMARY KEY,
  "user_id"     uuid NOT NULL,
  "cert_id"     text NOT NULL,
  "revoked_by"  uuid NOT NULL,
  "approved_by" text NOT NULL,
  "reason"      text NOT NULL,
  "revoked_at"  timestamptz NOT NULL,
  CONSTRAINT "cert_revocations_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);

DO $$ BEGIN
  ALTER TABLE "academy"."cert_issue_rule_events"
    ADD CONSTRAINT "cert_issue_rule_events_mode_chk" CHECK ("mode" IN ('manual', 'automatic', 'delayed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

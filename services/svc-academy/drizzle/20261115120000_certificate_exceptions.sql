-- svc-academy · issuing a certificate as an exception (AC-certificates-02, J-academy-17 #5)
-- Reversal: 20261115120000_certificate_exceptions.down.sql
--
-- Staff issue one learner a certificate without every required item, with a reason, under two-person approval. The grant
-- is the learner's one ordinary grant row (so it prints, verifies and can be revoked like any other); this table records
-- once who proposed and approved it (from identity's approval), who carried it out, why and when. A repeat answers with
-- the first record. A certificate never moves money.

CREATE TABLE IF NOT EXISTS "academy"."cert_exceptions" (
  "public_id"   text PRIMARY KEY,
  "user_id"     uuid NOT NULL,
  "cert_id"     text NOT NULL,
  "proposed_by" text NOT NULL,
  "approved_by" text NOT NULL,
  "granted_by"  uuid NOT NULL,
  "reason"      text NOT NULL,
  "granted_at"  timestamptz NOT NULL,
  CONSTRAINT "cert_exceptions_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  CONSTRAINT "cert_exceptions_one_per_grant" UNIQUE ("user_id", "cert_id")
);

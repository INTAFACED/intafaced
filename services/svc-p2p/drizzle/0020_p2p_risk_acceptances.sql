-- P-disputes-security-08: the P2P risk notice a person accepted, by version.
-- One row per person and version, written once: accepting again changes nothing.
-- The version is owner-published (P2P_RISK_NOTICE_VERSION); a take refuses until
-- the current version has a row. No balance is stored here.
-- Reversal: 0020_p2p_risk_acceptances.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."risk_acceptances" (
  "user_id" text NOT NULL,
  "version" text NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "risk_acceptances_pk" PRIMARY KEY ("user_id", "version"),
  CONSTRAINT "risk_acceptances_version_ck" CHECK (length(btrim("version")) BETWEEN 1 AND 64)
);

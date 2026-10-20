-- svc-quant · risk disclosure versions and acceptances (AL-risk-02)
-- Reversal: 0002_quant_disclosure.down.sql
--
-- No money, no balance, no ledger post. The wording is owner content published by an operator;
-- nothing in this migration writes any. An acceptance row holds ids, versions and a time only.
--
-- A version row is the audit row for the publish: who (published_by), why (reason) and when.
-- Versions and acceptances are append-only.

CREATE TABLE IF NOT EXISTS "quant"."disclosure_versions" (
  "version"          integer PRIMARY KEY,
  "body"             text NOT NULL,
  "reason"           text NOT NULL,
  "published_by"     uuid NOT NULL,
  "idempotency_key"  text NOT NULL,
  "published_at"     timestamptz NOT NULL,
  CONSTRAINT "disclosure_versions_version_ck" CHECK ("version" >= 1),
  CONSTRAINT "disclosure_versions_body_ck" CHECK (char_length("body") BETWEEN 1 AND 20000),
  CONSTRAINT "disclosure_versions_reason_ck" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "disclosure_versions_key_len_ck" CHECK (char_length("idempotency_key") BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS "disclosure_versions_key_idx"
  ON "quant"."disclosure_versions" ("idempotency_key");

CREATE TABLE IF NOT EXISTS "quant"."disclosure_acceptances" (
  "account_id"          uuid NOT NULL,
  "strategy_id"         text NOT NULL,
  "strategy_version"    integer NOT NULL,
  "disclosure_version"  integer NOT NULL REFERENCES "quant"."disclosure_versions"("version"),
  "accepted_at"         timestamptz NOT NULL,
  "write_key"           text NOT NULL,
  PRIMARY KEY ("account_id", "strategy_id", "strategy_version", "disclosure_version"),
  CONSTRAINT "disclosure_acceptances_strategy_version_ck" CHECK ("strategy_version" >= 1),
  CONSTRAINT "disclosure_acceptances_key_len_ck" CHECK (char_length("write_key") BETWEEN 1 AND 256)
);

CREATE OR REPLACE FUNCTION "quant"."reject_disclosure_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quant.disclosure_immutable — % rows cannot be rewritten', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS "disclosure_versions_append_only" ON "quant"."disclosure_versions";
CREATE TRIGGER "disclosure_versions_append_only"
  BEFORE UPDATE OR DELETE ON "quant"."disclosure_versions"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_disclosure_rewrite"();

DROP TRIGGER IF EXISTS "disclosure_acceptances_append_only" ON "quant"."disclosure_acceptances";
CREATE TRIGGER "disclosure_acceptances_append_only"
  BEFORE UPDATE OR DELETE ON "quant"."disclosure_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_disclosure_rewrite"();

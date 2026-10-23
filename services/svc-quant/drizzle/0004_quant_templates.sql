-- svc-quant · first-party starter templates (AL-editor-03)
-- Reversal: 0004_quant_templates.down.sql
--
-- No money, no balance, no ledger post. A template is a named set of signal rules with every number blank, published
-- by an operator. Each version row is also the audit row for its publish: who (published_by), why (reason) and when.
-- Versions are append-only.

CREATE TABLE IF NOT EXISTS "quant"."templates" (
  "template_id"      text NOT NULL,
  "version"          integer NOT NULL,
  "name"             text NOT NULL,
  "description"      text NOT NULL,
  "rules"            jsonb NOT NULL,
  "release_note"     text NOT NULL,
  "reason"           text NOT NULL,
  "published_by"     uuid NOT NULL,
  "idempotency_key"  text NOT NULL,
  "published_at"     timestamptz NOT NULL,
  PRIMARY KEY ("template_id", "version"),
  CONSTRAINT "templates_id_ck" CHECK ("template_id" ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  CONSTRAINT "templates_version_ck" CHECK ("version" >= 1),
  CONSTRAINT "templates_name_ck" CHECK (char_length("name") BETWEEN 1 AND 128),
  CONSTRAINT "templates_description_ck" CHECK (char_length("description") BETWEEN 1 AND 1000),
  CONSTRAINT "templates_release_note_ck" CHECK (char_length("release_note") BETWEEN 1 AND 1000),
  CONSTRAINT "templates_reason_ck" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "templates_key_len_ck" CHECK (char_length("idempotency_key") BETWEEN 1 AND 128),
  -- Every number is blank: the person fills them in after Use. COALESCE so a missing key fails instead of passing.
  CONSTRAINT "templates_numbers_blank_ck" CHECK (
    COALESCE(
      jsonb_typeof("rules") = 'object'
      AND ("rules"->'signal'->>'fast') = ''
      AND ("rules"->'signal'->>'slow') = ''
      AND ("rules"->'sizing'->>'value') = ''
      AND ("rules"->'exit'->>'stopLossPercent') = ''
      AND ("rules"->'exit'->>'takeProfitPercent') = '',
      false
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "templates_key_idx" ON "quant"."templates" ("idempotency_key");

CREATE OR REPLACE FUNCTION "quant"."reject_template_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quant.template_immutable — version % of template % cannot be rewritten', OLD.version, OLD.template_id;
END;
$$;

DROP TRIGGER IF EXISTS "templates_append_only" ON "quant"."templates";
CREATE TRIGGER "templates_append_only"
  BEFORE UPDATE OR DELETE ON "quant"."templates"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_template_rewrite"();

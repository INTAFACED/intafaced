-- svc-quant · withdraw and restore a starter template (AL-editor-03)
-- Reversal: 20261115090000_quant_template_listing.down.sql
--
-- No money, no balance, no ledger post. An operator takes a starter template off the list (withdraw) or puts it back
-- (restore); its published versions are never touched. Each write is its own append-only row: who (set_by), why
-- (reason), when (set_at), keyed by the operator's idempotency key and numbered per template. The newest row says whether the template is listed;
-- a template with no row is listed.

CREATE TABLE IF NOT EXISTS "quant"."template_listing" (
  "template_id"      text NOT NULL,
  "seq"              integer NOT NULL,
  "listed"           boolean NOT NULL,
  "reason"           text NOT NULL,
  "set_by"           uuid NOT NULL,
  "idempotency_key"  text NOT NULL,
  "set_at"           timestamptz NOT NULL,
  PRIMARY KEY ("template_id", "seq"),
  CONSTRAINT "template_listing_seq_ck" CHECK ("seq" >= 1),
  CONSTRAINT "template_listing_reason_ck" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "template_listing_key_len_ck" CHECK (char_length("idempotency_key") BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS "template_listing_key_idx" ON "quant"."template_listing" ("idempotency_key");

CREATE OR REPLACE FUNCTION "quant"."reject_template_listing_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quant.template_immutable — listing row % of template % cannot be rewritten', OLD.seq, OLD.template_id;
END;
$$;

DROP TRIGGER IF EXISTS "template_listing_append_only" ON "quant"."template_listing";
CREATE TRIGGER "template_listing_append_only"
  BEFORE UPDATE OR DELETE ON "quant"."template_listing"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_template_listing_rewrite"();

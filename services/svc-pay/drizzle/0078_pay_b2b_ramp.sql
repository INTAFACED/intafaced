-- W10 B2B ramp, switched off.
--
-- A bank statement line and, once, the credit that was allowed to follow it.
-- The client's claim is not a column: credit is admitted only by matching a
-- row in b2b_ramp_bank_lines. This is not a balance and not a ledger post.
-- Intake, batches, executions and events are not built. ledger_posted is
-- constrained false so this table cannot become a second book.

CREATE TABLE IF NOT EXISTS "pay"."b2b_ramp_bank_lines" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "line_id"      text NOT NULL,
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "amount"       numeric(38,18) NOT NULL,
  "asset"        text NOT NULL,
  "reference"    text NOT NULL,
  "posted_at"    timestamptz NOT NULL,
  "source"       text NOT NULL DEFAULT 'bank_statement',
  "recorded_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "b2b_ramp_bank_lines_line_id_ck" CHECK (char_length(btrim("line_id")) > 0),
  CONSTRAINT "b2b_ramp_bank_lines_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "b2b_ramp_bank_lines_asset_ck" CHECK (char_length(btrim("asset")) > 0),
  CONSTRAINT "b2b_ramp_bank_lines_reference_ck" CHECK (char_length(btrim("reference")) > 0),
  CONSTRAINT "b2b_ramp_bank_lines_source_ck" CHECK ("source" = 'bank_statement')
);

CREATE UNIQUE INDEX IF NOT EXISTS "b2b_ramp_bank_lines_line_id_idx"
  ON "pay"."b2b_ramp_bank_lines" ("line_id");

CREATE INDEX IF NOT EXISTS "b2b_ramp_bank_lines_merchant_idx"
  ON "pay"."b2b_ramp_bank_lines" ("merchant_id");

CREATE TABLE IF NOT EXISTS "pay"."b2b_ramp_credits" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "bank_line_pk"   uuid NOT NULL REFERENCES "pay"."b2b_ramp_bank_lines"("id"),
  "merchant_id"    uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "amount"         numeric(38,18) NOT NULL,
  "asset"          text NOT NULL,
  "ledger_posted"  boolean NOT NULL DEFAULT false,
  "admitted_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "b2b_ramp_credits_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "b2b_ramp_credits_asset_ck" CHECK (char_length(btrim("asset")) > 0),
  CONSTRAINT "b2b_ramp_credits_not_a_ledger_post_ck" CHECK ("ledger_posted" = false)
);

CREATE UNIQUE INDEX IF NOT EXISTS "b2b_ramp_credits_one_line_idx"
  ON "pay"."b2b_ramp_credits" ("bank_line_pk");

CREATE INDEX IF NOT EXISTS "b2b_ramp_credits_merchant_idx"
  ON "pay"."b2b_ramp_credits" ("merchant_id");

-- A statement line is a fact. Changing it after the fact would let a later
-- credit match a different amount than the bank wrote.
CREATE OR REPLACE FUNCTION "pay"."b2b_ramp_bank_lines_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.b2b_ramp_bank_lines is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "b2b_ramp_bank_lines_append_only_trg" ON "pay"."b2b_ramp_bank_lines";
CREATE TRIGGER "b2b_ramp_bank_lines_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."b2b_ramp_bank_lines"
  FOR EACH ROW EXECUTE FUNCTION "pay"."b2b_ramp_bank_lines_append_only"();

CREATE OR REPLACE FUNCTION "pay"."b2b_ramp_credits_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.b2b_ramp_credits is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "b2b_ramp_credits_append_only_trg" ON "pay"."b2b_ramp_credits";
CREATE TRIGGER "b2b_ramp_credits_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."b2b_ramp_credits"
  FOR EACH ROW EXECUTE FUNCTION "pay"."b2b_ramp_credits_append_only"();

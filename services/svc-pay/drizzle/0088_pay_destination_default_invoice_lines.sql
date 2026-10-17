-- Destination default flag, and invoice due date, customer email, and lines.
-- Reversal: 0088_pay_destination_default_invoice_lines.down.sql
--
-- is_default is false on every existing row. Nothing becomes the default until
-- the owner marks one. At most one default per merchant.
--
-- Invoice lines do not post to the ledger. line_amount is quantity times the
-- unit amount, negative when kind is credit. A charge may be zero. A credit
-- must be negative. A deferred check refuses a header total that is not the
-- signed sum of its lines, and refuses a sum that is not above zero. An
-- invoice with no lines keeps the header amount it was given. The header
-- amount check (amount > 0) stays on merchant_invoices.
--
-- merchant_visible defaults false. A merchant reads their own tier and any
-- tier flagged visible. This column rides 0088 because that migration is not
-- on main yet; no later number was assigned.

ALTER TABLE "pay"."merchant_payout_destinations"
  ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_payout_destinations_one_default_idx"
  ON "pay"."merchant_payout_destinations" ("merchant_id")
  WHERE "is_default";

ALTER TABLE "pay"."control_tiers"
  ADD COLUMN IF NOT EXISTS "merchant_visible" boolean NOT NULL DEFAULT false;

ALTER TABLE "pay"."merchant_invoices"
  ADD COLUMN IF NOT EXISTS "due_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "customer_email" text;

ALTER TABLE "pay"."merchant_invoices"
  DROP CONSTRAINT IF EXISTS "merchant_invoices_email_ck";

ALTER TABLE "pay"."merchant_invoices"
  ADD CONSTRAINT "merchant_invoices_email_ck"
  CHECK (
    "customer_email" IS NULL
    OR (
      char_length("customer_email") BETWEEN 3 AND 254
      AND "customer_email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  );

CREATE TABLE IF NOT EXISTS "pay"."merchant_invoice_lines" (
  "invoice_id" uuid NOT NULL REFERENCES "pay"."merchant_invoices"("id") ON DELETE CASCADE,
  "line_no" integer NOT NULL,
  "description" text NOT NULL,
  "quantity" numeric(38, 18) NOT NULL,
  "unit_amount" numeric(38, 18) NOT NULL,
  "line_amount" numeric(38, 18) NOT NULL,
  "kind" text NOT NULL DEFAULT 'charge',
  PRIMARY KEY ("invoice_id", "line_no"),
  CONSTRAINT "merchant_invoice_lines_no_ck" CHECK ("line_no" BETWEEN 1 AND 40),
  CONSTRAINT "merchant_invoice_lines_description_ck"
    CHECK (char_length(btrim("description")) BETWEEN 1 AND 500),
  CONSTRAINT "merchant_invoice_lines_quantity_ck" CHECK ("quantity" > 0),
  CONSTRAINT "merchant_invoice_lines_kind_ck" CHECK ("kind" IN ('charge', 'credit')),
  CONSTRAINT "merchant_invoice_lines_sign_ck" CHECK (
    ("kind" = 'charge' AND "unit_amount" >= 0 AND "line_amount" >= 0)
    OR ("kind" = 'credit' AND "line_amount" < 0)
  )
);

CREATE OR REPLACE FUNCTION "pay"."merchant_invoice_lines_match_total"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  inv uuid;
  header numeric;
  summed numeric;
  n integer;
BEGIN
  inv := COALESCE(NEW.invoice_id, OLD.invoice_id);
  SELECT amount INTO header FROM pay.merchant_invoices WHERE id = inv;
  SELECT COALESCE(sum(line_amount), 0), count(*)::int INTO summed, n
    FROM pay.merchant_invoice_lines WHERE invoice_id = inv;
  IF n > 0 AND summed <= 0 THEN
    RAISE EXCEPTION 'pay.invoice_total_not_positive' USING ERRCODE = 'check_violation';
  END IF;
  IF n > 0 AND summed IS DISTINCT FROM header THEN
    RAISE EXCEPTION 'pay.invoice_total_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "merchant_invoice_lines_match_total_trg" ON "pay"."merchant_invoice_lines";
CREATE CONSTRAINT TRIGGER "merchant_invoice_lines_match_total_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "pay"."merchant_invoice_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "pay"."merchant_invoice_lines_match_total"();

-- Standalone merchant invoices. Not subscription executions.
-- Reversal: 0084_pay_merchant_invoices.down.sql
--
-- An invoice records an amount the merchant asked a customer to pay. Sending
-- it marks the row sent and points at a hosted payment link. Paying that link
-- is the existing payment flow. This table does not post to the ledger.
-- mark-paid records that an existing captured or settled payment covered it.

CREATE TABLE IF NOT EXISTS "pay"."merchant_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "status" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "customer_ref" text,
  "description" text,
  "payment_link_id" uuid REFERENCES "pay"."payment_links"("id"),
  "payment_id" uuid REFERENCES "pay"."payments"("id"),
  "sent_at" timestamptz,
  "voided_at" timestamptz,
  "paid_at" timestamptz,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "merchant_invoices_status_ck"
    CHECK ("status" IN ('draft', 'sent', 'void', 'paid')),
  CONSTRAINT "merchant_invoices_asset_ck"
    CHECK ("asset_id" ~ '^[A-Za-z0-9._-]{1,16}$'),
  CONSTRAINT "merchant_invoices_amount_ck"
    CHECK ("amount" > 0),
  CONSTRAINT "merchant_invoices_customer_ck"
    CHECK ("customer_ref" IS NULL OR char_length(btrim("customer_ref")) BETWEEN 1 AND 200),
  CONSTRAINT "merchant_invoices_description_ck"
    CHECK ("description" IS NULL OR char_length(btrim("description")) BETWEEN 1 AND 2000),
  CONSTRAINT "merchant_invoices_created_by_ck"
    CHECK (char_length(btrim("created_by")) > 0),
  CONSTRAINT "merchant_invoices_sent_ck"
    CHECK (("status" = 'sent' AND "sent_at" IS NOT NULL AND "payment_link_id" IS NOT NULL)
        OR ("status" <> 'sent')),
  CONSTRAINT "merchant_invoices_void_ck"
    CHECK (("status" = 'void' AND "voided_at" IS NOT NULL) OR ("status" <> 'void')),
  CONSTRAINT "merchant_invoices_paid_ck"
    CHECK (("status" = 'paid' AND "paid_at" IS NOT NULL AND "payment_id" IS NOT NULL)
        OR ("status" <> 'paid'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_invoices_payment_uq"
  ON "pay"."merchant_invoices" ("payment_id")
  WHERE "payment_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "merchant_invoices_list_idx"
  ON "pay"."merchant_invoices" ("merchant_id", "created_at" DESC, "id" DESC);

CREATE TABLE IF NOT EXISTS "pay"."merchant_invoice_actions" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id" uuid NOT NULL,
  "invoice_id" uuid NOT NULL REFERENCES "pay"."merchant_invoices"("id"),
  "action" text NOT NULL,
  "fingerprint" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "request_id"),
  CONSTRAINT "merchant_invoice_actions_action_ck"
    CHECK ("action" IN ('create', 'send', 'void', 'mark_paid')),
  CONSTRAINT "merchant_invoice_actions_fingerprint_ck"
    CHECK ("fingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS "merchant_invoice_actions_invoice_idx"
  ON "pay"."merchant_invoice_actions" ("merchant_id", "invoice_id");

CREATE OR REPLACE FUNCTION "pay"."merchant_invoice_actions_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "merchant_invoice_actions_append_only_trg" ON "pay"."merchant_invoice_actions";
CREATE TRIGGER "merchant_invoice_actions_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."merchant_invoice_actions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."merchant_invoice_actions_append_only"();

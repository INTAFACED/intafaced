-- Loan product rate changes (BK-loan-02, J-bank-09 #5).
--
-- `loan_product_rate_changes` records each operator change to a product's rate: the rate set, the rate it replaced (read
-- under the same row lock as the update, so two changes never report the same previous rate), the reason and the second
-- person who approved it, under that approval's id (one approval makes one change; a retry with it reads the change back).
-- The approval is also bound to the rate it replaces, so it can't be spent once the rate has moved. New loans open at the product's current rate; an open loan keeps the rate written on its own
-- row at open, so this history explains the product, never a loan's accrual.
--
-- Reversal: 20261030140000_loan_product_rate_changes.down.sql (refuses while any change is recorded).

CREATE TABLE IF NOT EXISTS "bank"."loan_product_rate_changes" (
  "id" bigserial PRIMARY KEY,
  "product_id" uuid NOT NULL REFERENCES "bank"."loan_products" ("id"),
  "apr_bps" integer NOT NULL,
  "previous_apr_bps" integer NOT NULL,
  "reason" text NOT NULL,
  "approval_id" text NOT NULL UNIQUE,
  "approved_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "loan_product_rate_changes_bps_ck" CHECK ("apr_bps" BETWEEN 0 AND 10000 AND "previous_apr_bps" BETWEEN 0 AND 10000),
  CONSTRAINT "loan_product_rate_changes_changed_ck" CHECK ("apr_bps" <> "previous_apr_bps"),
  CONSTRAINT "loan_product_rate_changes_reason_ck" CHECK (length(btrim("reason")) BETWEEN 3 AND 300)
);

CREATE INDEX IF NOT EXISTS "loan_product_rate_changes_product_idx" ON "bank"."loan_product_rate_changes" ("product_id", "id");

CREATE OR REPLACE FUNCTION "bank"."loan_product_rate_changes_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'loan_product_rate_changes row % is append-only: an approved rate change stays recorded', OLD."id"
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER "loan_product_rate_changes_append_only_trg"
  BEFORE UPDATE OR DELETE ON "bank"."loan_product_rate_changes"
  FOR EACH ROW EXECUTE FUNCTION "bank"."loan_product_rate_changes_append_only"();

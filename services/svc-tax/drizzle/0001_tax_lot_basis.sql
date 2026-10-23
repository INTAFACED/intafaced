-- svc-tax · a customer's own price for a lot with no cost (J-portfolio-04 steps 6 and 7)
-- Reversal: 0001_tax_lot_basis.down.sql
--
-- A price per coin the customer entered for one of their lots whose cost the platform does not know (a deposit, a reward, a
-- move in). It is an input to their profit and loss indicator, labelled customer-entered wherever it is used. It changes no
-- balance and no ledger fact. Rows are only added: each change is a new version, and a removal is a version whose price is
-- null. (user_id, lot_id, version) is the business key `basisoverride:<userId>:<lotId>:<version>`.
--
-- Every statement is idempotent, so the file is re-runnable.

CREATE TABLE IF NOT EXISTS "tax"."lot_basis" (
  "user_id"        uuid           NOT NULL,
  -- `lot:<acquireTxId>:<assetId>`, the lot book's repeatable id.
  "lot_id"         text           NOT NULL,
  "version"        integer        NOT NULL,
  -- Dollars per coin; null removes the entry.
  "price_per_unit" numeric(38,18),
  "note"           text           NOT NULL DEFAULT '',
  "created_at"     timestamptz    NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "lot_id", "version")
);

ALTER TABLE "tax"."lot_basis" DROP CONSTRAINT IF EXISTS "lot_basis_values_check";
ALTER TABLE "tax"."lot_basis" ADD CONSTRAINT "lot_basis_values_check"
  CHECK ("version" > 0 AND ("price_per_unit" IS NULL OR "price_per_unit" > 0) AND char_length("note") <= 200);

-- Append-only: a row, once written, is never changed or deleted by the service.
CREATE OR REPLACE FUNCTION "tax"."lot_basis_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tax.lot_basis is append-only';
END;
$$;
DROP TRIGGER IF EXISTS "lot_basis_append_only" ON "tax"."lot_basis";
CREATE TRIGGER "lot_basis_append_only" BEFORE UPDATE OR DELETE ON "tax"."lot_basis"
  FOR EACH ROW EXECUTE FUNCTION "tax"."lot_basis_append_only"();

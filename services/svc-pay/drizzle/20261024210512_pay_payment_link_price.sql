-- THE CATALOGUE PRICE A PAYMENT LINK SELLS (M-catalogue-03, J-merchant-04 step 2).
--
-- A payment link may be made from a one-time fixed price of an active product. The link charges that price's amount and
-- asset (svc-pay copies them onto the link when it is made) and keeps the price for its whole life: replacing or
-- archiving the price, or archiving its product, never changes a link, and a link names what it was sold at after that.
-- A price a link uses cannot be deleted (the foreign key refuses it); prices are never deleted today.

ALTER TABLE "pay"."payment_links"
  ADD COLUMN IF NOT EXISTS "price_id" uuid REFERENCES "pay"."catalog_prices"("id");

CREATE INDEX IF NOT EXISTS "payment_links_price_idx" ON "pay"."payment_links" ("price_id") WHERE "price_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "pay"."payment_links_price_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."price_id" IS DISTINCT FROM OLD."price_id" THEN
    RAISE EXCEPTION 'pay.payment_links: a link keeps the price it was made from.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "payment_links_price_kept_trg" ON "pay"."payment_links";
CREATE TRIGGER "payment_links_price_kept_trg"
  BEFORE UPDATE OF "price_id" ON "pay"."payment_links"
  FOR EACH ROW EXECUTE FUNCTION "pay"."payment_links_price_kept"();

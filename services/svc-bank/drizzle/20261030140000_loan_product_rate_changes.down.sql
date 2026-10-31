-- Reverses 20261030140000. Fails closed: an approved rate change is something operators were told, so this never drops one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."loan_product_rate_changes") THEN
    RAISE EXCEPTION 'loan product rate changes are recorded; 20261030140000 is not reversed';
  END IF;
END $$;

DROP TRIGGER IF EXISTS "loan_product_rate_changes_append_only_trg" ON "bank"."loan_product_rate_changes";
DROP FUNCTION IF EXISTS "bank"."loan_product_rate_changes_append_only"();
DROP TABLE IF EXISTS "bank"."loan_product_rate_changes";

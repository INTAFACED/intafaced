-- Reverses 20261025011247. Fails closed: a recorded renewal is a term a saver was locked into, so this never deletes one.
-- With no renewals, it drops the append-only trigger, the empty table and the saver's choice.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."earn_renewals") THEN
    RAISE EXCEPTION 'earn renewals are recorded; they are terms savers were locked into, so 20261025011247 is not reversed';
  END IF;
END $$;

DROP TRIGGER IF EXISTS "earn_renewals_append_only_trg" ON "bank"."earn_renewals";
DROP FUNCTION IF EXISTS "bank"."earn_renewals_append_only"();
DROP TABLE IF EXISTS "bank"."earn_renewals";
ALTER TABLE "bank"."earn_positions" DROP CONSTRAINT IF EXISTS "earn_positions_auto_renew_fixed_ck";
ALTER TABLE "bank"."earn_positions" DROP COLUMN IF EXISTS "auto_renew";

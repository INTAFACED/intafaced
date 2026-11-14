-- Reverses 20261115090000_card_cashback_to_wallet.sql. Refuses, changing nothing, while any wallet cashback row exists:
-- dropping the columns would make a cashback the rewards programme owes look like a custodial one waiting to be posted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."card_cashback" WHERE "paid_by" = 'wallet') THEN
    RAISE EXCEPTION 'bank.card_cashback holds wallet cashback rows; refusing to drop paid_by';
  END IF;
END $$;

ALTER TABLE "bank"."card_cashback" DROP CONSTRAINT IF EXISTS "card_cashback_paid_by_ck";
ALTER TABLE "bank"."card_cashback" DROP COLUMN IF EXISTS "announced_at";
ALTER TABLE "bank"."card_cashback" DROP COLUMN IF EXISTS "tier";
ALTER TABLE "bank"."card_cashback" DROP COLUMN IF EXISTS "spend";
ALTER TABLE "bank"."card_cashback" DROP COLUMN IF EXISTS "paid_by";

-- Refuses, changing nothing, while any request names a wallet: the old checks re-added below have no `delivered`
-- status, and dropping the columns would erase where a partner delivered a purchase.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."add_money_requests" WHERE "wallet_address" IS NOT NULL OR "status" = 'delivered') THEN
    RAISE EXCEPTION 'add_money_to_wallet down: wallet requests exist; nothing was changed';
  END IF;
END
$$;

ALTER TABLE "bank"."add_money_requests" DROP CONSTRAINT IF EXISTS "add_money_requests_status_ck";
ALTER TABLE "bank"."add_money_requests" ADD CONSTRAINT "add_money_requests_status_ck" CHECK (
  ("status" = 'opening' AND "refusal_code" IS NULL AND "onramp_id" IS NULL AND "quote_id" IS NOT NULL)
  OR ("status" = 'refused' AND "refusal_code" IS NOT NULL AND "onramp_id" IS NULL)
  OR (
    "status" IN ('opened', 'pending', 'credited', 'returned')
    AND "refusal_code" IS NULL AND "onramp_id" IS NOT NULL AND "quote_id" IS NOT NULL
  )
);
ALTER TABLE "bank"."add_money_requests" DROP CONSTRAINT IF EXISTS "add_money_requests_wallet_ck";
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "wallet_signature";
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "delivery_tx";
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "delivered_at";
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "wallet_address";

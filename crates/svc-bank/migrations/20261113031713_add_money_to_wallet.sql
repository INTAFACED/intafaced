-- Buy to wallet (J-dex-protocol-05 #4): an add-money request may name the person's own wallet, and the partner then
-- delivers the purchase to that address on chain instead of it being added to a balance. INTAFACED holds none of it and
-- the ledger posts nothing. The partner's "paid" for such a request carries its on-chain transfer, and the request then
-- reads `delivered` with when and that transfer's hash. A wallet request is never credited or returned here, and a
-- balance request is never delivered. A wallet request keeps the person's signature that proved they control the
-- wallet (EIP-191, over the request id and the address). This table is a record, never a balance.
--
-- Reversal: 20261113031713_add_money_to_wallet.down.sql

ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "wallet_address" text;
ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "delivered_at" timestamptz;
ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "delivery_tx" text;
ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "wallet_signature" text;

ALTER TABLE "bank"."add_money_requests" DROP CONSTRAINT IF EXISTS "add_money_requests_wallet_ck";
ALTER TABLE "bank"."add_money_requests" ADD CONSTRAINT "add_money_requests_wallet_ck" CHECK (
  ("wallet_address" IS NULL OR "wallet_address" ~ '^0x[0-9a-f]{40}$')
  AND (("wallet_address" IS NULL) = ("wallet_signature" IS NULL))
  AND ("wallet_signature" IS NULL OR "wallet_signature" ~ '^0x[0-9a-f]{130}$')
  AND ("delivery_tx" IS NULL OR "delivery_tx" ~ '^0x[0-9a-f]{64}$')
  AND (("status" = 'delivered') = ("delivered_at" IS NOT NULL AND "delivery_tx" IS NOT NULL))
  AND ("status" = 'delivered' OR ("delivered_at" IS NULL AND "delivery_tx" IS NULL))
  AND ("status" <> 'delivered' OR "wallet_address" IS NOT NULL)
  AND ("status" NOT IN ('credited', 'returned') OR "wallet_address" IS NULL)
);

ALTER TABLE "bank"."add_money_requests" DROP CONSTRAINT IF EXISTS "add_money_requests_status_ck";
ALTER TABLE "bank"."add_money_requests" ADD CONSTRAINT "add_money_requests_status_ck" CHECK (
  ("status" = 'opening' AND "refusal_code" IS NULL AND "onramp_id" IS NULL AND "quote_id" IS NOT NULL)
  OR ("status" = 'refused' AND "refusal_code" IS NOT NULL AND "onramp_id" IS NULL)
  OR (
    "status" IN ('opened', 'pending', 'credited', 'returned', 'delivered')
    AND "refusal_code" IS NULL AND "onramp_id" IS NOT NULL AND "quote_id" IS NOT NULL
  )
);

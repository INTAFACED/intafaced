-- J-bank-29 #2 (BK-ccrypto-01): a person's pay-from order, the assets a card payment is taken from, first to last.
-- A preference, not money: no amount, no balance. Each asset was one the owner lists and the card partner can spend from
-- when it was saved; the partner holds and spends the money (OWNER 226), so nothing here is a balance of ours.
CREATE TABLE IF NOT EXISTS "bank"."card_pay_from_orders" (
  "user_id" text PRIMARY KEY,
  "asset_ids" text[] NOT NULL CHECK (cardinality("asset_ids") BETWEEN 1 AND 50),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

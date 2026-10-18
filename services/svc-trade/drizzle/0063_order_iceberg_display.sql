-- trade.orders · visible iceberg peak echoed on the order (ICE-1)
-- Reversal: 0063_order_iceberg_display.down.sql
--
-- The peak is the caller's displayQty. A replay of the same client order id
-- reads this row and returns the first peak. Trade does not invent one.

CREATE TABLE IF NOT EXISTS "trade"."order_iceberg_display" (
  "order_id"     uuid PRIMARY KEY REFERENCES "trade"."orders" ("id"),
  "user_id"      uuid NOT NULL,
  "display_qty"  numeric(38, 18) NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "order_iceberg_display_positive_ck" CHECK ("display_qty" > 0)
);

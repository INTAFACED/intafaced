-- Caller label on an order (SP-order-entry-04). Never part of the idempotency key. Null when none was sent.
-- Reversal: 0084_order_tag.down.sql
ALTER TABLE trade.orders ADD COLUMN IF NOT EXISTS tag text CHECK (tag IS NULL OR char_length(tag) BETWEEN 1 AND 16);

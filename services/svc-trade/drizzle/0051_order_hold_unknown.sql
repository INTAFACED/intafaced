-- trade.orders · hold reply lost (TRD-0540)
-- Reversal: 0051_order_hold_unknown.down.sql
--
-- ADD VALUE alone. Postgres cannot use a new enum label in the transaction
-- that added it. No column uses the label here.
--
-- `hold_unknown` is the order whose `order.hold` post did not return. The
-- hold may already be booked. The row stays until getTxByKey on
-- `order.hold:<orderId>` says the hold is absent.

ALTER TYPE "trade"."order_status" ADD VALUE IF NOT EXISTS 'hold_unknown';

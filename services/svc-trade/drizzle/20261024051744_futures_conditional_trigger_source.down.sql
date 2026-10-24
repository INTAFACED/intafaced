-- intafaced:destructive — reversal of 20261024051744_futures_conditional_trigger_source.sql
-- Older code judges every order on the mark. An armed order judged on the last trade would silently move to the mark,
-- so it is cancelled first (`replaced`); its owner places it again.
UPDATE "trade"."futures_conditional_orders"
  SET "status" = 'cancelled', "cancel_reason" = 'replaced', "updated_at" = now()
  WHERE "trigger_source" <> 'mark' AND "status" = 'armed';

DROP INDEX IF EXISTS "trade"."futures_order_fills_market_sequence_idx";
ALTER TABLE "trade"."futures_conditional_orders" DROP CONSTRAINT IF EXISTS "futures_conditional_orders_trigger_source_ck";
ALTER TABLE "trade"."futures_conditional_orders" DROP COLUMN IF EXISTS "trigger_source";

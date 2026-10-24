-- intafaced:destructive — reversal of 0105_futures_protection_partial.sql
-- Without the marker, code before it reads every take-profit or stop-loss leg as covering the whole position, so a
-- part leg still armed would close all of it. Those are cancelled first; their owners set them again.
UPDATE trade.futures_conditional_orders
SET status = 'cancelled', cancel_reason = 'replaced', updated_at = now()
WHERE "part_leg" AND status = 'armed';
ALTER TABLE trade.futures_conditional_orders DROP CONSTRAINT IF EXISTS "futures_conditional_orders_part_leg_ck";
ALTER TABLE trade.futures_conditional_orders DROP COLUMN IF EXISTS "part_leg";

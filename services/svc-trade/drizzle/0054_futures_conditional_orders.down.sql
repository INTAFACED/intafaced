-- Reverses 0054_futures_conditional_orders.sql.

DROP TRIGGER IF EXISTS "futures_protection_on_close" ON "trade"."positions";
DROP FUNCTION IF EXISTS "trade"."futures_cancel_protection_on_close"();
DROP TABLE IF EXISTS "trade"."futures_protection_requests";
DROP TABLE IF EXISTS "trade"."futures_conditional_orders";

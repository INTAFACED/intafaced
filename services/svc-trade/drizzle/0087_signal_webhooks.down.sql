-- Reverses 0087_signal_webhooks.sql. Drops the alert audit trail; orders already placed stay in trade.orders.
DROP TABLE IF EXISTS trade.signal_alerts;
DROP TABLE IF EXISTS trade.signal_webhooks;

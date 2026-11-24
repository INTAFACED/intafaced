-- Reverses 20261123194332_user_venue_risk_alerts.sql.
DROP TRIGGER IF EXISTS user_venue_risk_alerts_once_trg ON trade.user_venue_risk_alerts;
DROP FUNCTION IF EXISTS trade.user_venue_risk_alerts_once();
DROP TABLE IF EXISTS trade.user_venue_risk_alerts;
DROP TABLE IF EXISTS trade.user_venue_risk_alert_settings;

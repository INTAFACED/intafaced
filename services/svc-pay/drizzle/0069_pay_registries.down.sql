-- intafaced:destructive — reversal of 0069_pay_registries.sql
--
-- Drops the venue, network and wallet-route registries and every row in them.
-- They hold routing configuration only (no balances, no credentials). The
-- audit history in registry_events (0070) is dropped by 0070's own reversal,
-- which runs first.

DROP TABLE IF EXISTS "pay"."wallet_routes";
DROP TABLE IF EXISTS "pay"."network_registry";
DROP TABLE IF EXISTS "pay"."venue_registry";

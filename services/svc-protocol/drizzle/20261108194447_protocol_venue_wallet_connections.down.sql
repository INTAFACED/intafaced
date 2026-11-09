-- Reverses 20261108194447_protocol_venue_wallet_connections.sql. Connections are records of addresses only; dropping them
-- moves nothing, and every wallet signs again to connect.
DROP TABLE IF EXISTS "protocol"."venue_wallet_nonces";
DROP TABLE IF EXISTS "protocol"."venue_wallet_connections";

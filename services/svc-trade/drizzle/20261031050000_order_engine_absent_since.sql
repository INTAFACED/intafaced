-- trade.orders · when a cancel first found the order gone from the matching engine with no answer stored
-- Reversal: 20261031050000_order_engine_absent_since.down.sql
--
-- A miss means the engine took the order off its book by a fill, a cancel or an expiry, and each of those reaches
-- this service as an event. Until one does, what it matched is unknown, so the hold stays (#6874). A submit whose outcome
-- was unknown may never have reached the engine, so past the in-flight bound from this time a cancel releases.

ALTER TABLE "trade"."orders"
  ADD COLUMN IF NOT EXISTS "engine_absent_since" timestamptz;

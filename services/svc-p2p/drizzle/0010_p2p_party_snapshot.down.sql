-- Reversal of 0010_p2p_party_snapshot.sql.
--
-- NOT tagged `intafaced:destructive`: drops the trigger only. Afterwards an
-- UPDATE can re-point seller_id and buyer_id on an existing trade.

DROP TRIGGER IF EXISTS "p2p_trades_parties_are_snapshotted_trg" ON "p2p"."p2p_trades";
DROP FUNCTION IF EXISTS "p2p"."p2p_trades_parties_are_snapshotted"();

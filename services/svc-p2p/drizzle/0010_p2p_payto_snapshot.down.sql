-- Reversal of 0010_p2p_payto_snapshot.sql.
--
-- NOT tagged `intafaced:destructive`: drops the trigger only. Afterwards an
-- UPDATE can swap details and fingerprint on an unpurged snapshot.
-- trade_payment_instruments_purge_paired_ck stays.

DROP TRIGGER IF EXISTS "trade_payment_instruments_destination_frozen_trg" ON "p2p"."trade_payment_instruments";
DROP FUNCTION IF EXISTS "p2p"."trade_payment_instruments_destination_is_frozen"();

-- Reverse 0010_p2p_escrow_amount_frozen.sql
--
-- Afterwards a trade with escrowed_at set can have its amount lowered again,
-- including by clearing the timestamp first and changing amount on the next
-- statement. Settlement would release the new figure and leave the difference
-- in that escrow account. This file exists so the migration is reversible
-- (§14 DoD 1). Do not run it against a database holding escrow.

DROP TRIGGER IF EXISTS "p2p_trades_escrow_amount_frozen_trg" ON "p2p"."p2p_trades";
DROP FUNCTION IF EXISTS "p2p"."p2p_trades_escrow_amount_frozen"();

ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_escrow_amount_matches_ck";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "escrow_amount";

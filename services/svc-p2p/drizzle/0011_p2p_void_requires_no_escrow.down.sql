-- Reverse 0011_p2p_void_requires_no_escrow.sql
--
-- Afterwards an escrowed trade can be marked voided again, including by
-- clearing escrowed_at in the same statement. settleOnce posts nothing for
-- voided, so the seller's escrow stays in the per-trade escrow account.
-- This file exists so the migration is reversible (§14 DoD 1). Do not run it
-- against a database holding escrow.

ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_voided_requires_no_escrow_ck";

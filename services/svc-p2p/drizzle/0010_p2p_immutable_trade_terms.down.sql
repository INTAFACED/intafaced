-- intafaced:destructive — reverse original-term protection and remove its provenance column.
-- Reversal loses provenance; reapplying leaves surviving rows unproven. No backfill.
DROP TRIGGER IF EXISTS "p2p_trades_original_terms_frozen_trg" ON "p2p"."p2p_trades";
DROP FUNCTION IF EXISTS "p2p"."p2p_trades_original_terms_frozen"();
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_voided_requires_no_escrow_ck";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "original_terms_claimed_at";

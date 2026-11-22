-- Reverses 20261114215747_round_up_partner_move.sql. Refuses while any round-up the partner made is recorded, so a
-- partner's reference is never dropped from the book of runs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."auto_invest_runs" WHERE "partner_move_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'auto_invest_runs holds partner moves; refusing to drop partner_move_id';
  END IF;
END $$;
ALTER TABLE "bank"."auto_invest_runs" DROP CONSTRAINT IF EXISTS "auto_invest_runs_rejected_omits_partner_move_ck";
ALTER TABLE "bank"."auto_invest_runs" DROP CONSTRAINT IF EXISTS "auto_invest_runs_one_movement_ck";
ALTER TABLE "bank"."auto_invest_runs" DROP COLUMN IF EXISTS "partner_move_id";

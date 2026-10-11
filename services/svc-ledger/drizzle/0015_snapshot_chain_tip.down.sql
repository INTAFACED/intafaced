-- intafaced:destructive — known snapshot anchors cannot be forgotten.
DO $$
BEGIN
  LOCK TABLE "ledger"."balance_snapshots" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "ledger"."balance_snapshots" WHERE "chain_tip_seq" IS NOT NULL OR "chain_tip_hash" IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot reverse 0015: recorded snapshot chain-tip identity must be preserved';
  END IF;
  ALTER TABLE "ledger"."balance_snapshots" DROP COLUMN "chain_tip_hash", DROP COLUMN "chain_tip_seq";
END $$;

-- Drops the edit history, the checks and the revision column. A rollback after edits loses which earlier amounts an
-- order had; the runs themselves keep the amount each one posted (`transfer_executions.amount`).
DROP TABLE IF EXISTS "bank"."schedule_revisions";
ALTER TABLE "bank"."auto_invest_rules" DROP CONSTRAINT IF EXISTS "auto_invest_rules_not_once_ck";
ALTER TABLE "bank"."scheduled_transfers" DROP CONSTRAINT IF EXISTS "scheduled_transfers_once_no_end_ck";
ALTER TABLE "bank"."scheduled_transfers" DROP CONSTRAINT IF EXISTS "scheduled_transfers_revision_ck";
ALTER TABLE "bank"."scheduled_transfers" DROP COLUMN IF EXISTS "revision";

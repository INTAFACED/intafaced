-- Drop the constraint. Unlike 0005 this one is genuinely reversible: it adds no
-- enum value and rewrites no row, so removing it returns the table to exactly
-- the shape it had before.
ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_skipped_moved_nothing_ck";

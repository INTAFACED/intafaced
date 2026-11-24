-- A skipped occurrence moved nothing, and must say why.
--
-- Separate from 0005 because `ALTER TYPE … ADD VALUE` and any use of the value
-- it adds cannot share a transaction, and the runner sends each file as one
-- simple query — so a CHECK naming 'skipped' in 0005 would fail with "unsafe
-- use of new value of enum type". Two files, two transactions.
--
-- The two constraints already on this table are the same idea from the other
-- directions: `settled` must point at a ledger transaction (no phantom
-- transfers), `rejected` must carry a code (no unexplained failures). The gap
-- was the value 0005 introduced. Nothing writes a `ledger_tx_id` on a skipped
-- row today, and `resumeSchedule` posts nothing at all — but "nothing does that
-- today" is the weakest guarantee available for a money table, and the whole
-- claim of pause/resume is that resuming moves no value. A skipped row holding
-- a transaction id would be that claim being false, recorded in the book, with
-- nobody able to tell it apart from a firing that really happened.
--
-- `rejection_code IS NOT NULL` for the same reason `rejected` carries one: the
-- row exists so that "why did nothing happen in March" has an answer.
ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_skipped_moved_nothing_ck";
ALTER TABLE "bank"."transfer_executions" ADD CONSTRAINT "transfer_executions_skipped_moved_nothing_ck"
  CHECK ("status" <> 'skipped' OR ("ledger_tx_id" IS NULL AND "settled_at" IS NULL AND "rejection_code" IS NOT NULL));

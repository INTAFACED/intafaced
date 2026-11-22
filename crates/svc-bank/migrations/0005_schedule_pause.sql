-- Standing orders you can pause: `skipped` becomes a recordable outcome of an
-- occurrence.
--
-- The `paused` value in `bank.schedule_status` shipped in 0000 and no code path
-- has ever written it. Making it reachable needs one thing the executions table
-- could not say: that occurrence N did not fire and WAS NEVER GOING TO, because
-- the order was paused when it came due.
--
-- It must be a row, not an absence. `MAX(occurrence)` over this table is what
-- `planDue` uses as `lastFired`, so an occurrence with no row is an occurrence
-- the next pass will fire. Without `skipped`, resuming an order paused for three
-- months would post three months of transfers at once — money the user paused
-- precisely to stop. The row is what makes "resume" mean "carry on from here"
-- instead of "settle up".
--
-- Not `rejected`: rejected means we tried and the ledger refused (an empty
-- space). A user asking where March's rent went is owed the difference.
DO $$ BEGIN
  ALTER TYPE "bank"."execution_status" ADD VALUE 'skipped' AFTER 'rejected';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

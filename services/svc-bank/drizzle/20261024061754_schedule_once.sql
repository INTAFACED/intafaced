-- A one-off scheduled payment (BK-xfer-10, J-bank-06 #1): `once` becomes a standing order cadence.
--
-- Alone in its file because `ALTER TYPE … ADD VALUE` and any use of the value it adds cannot share a transaction, and
-- the runner sends each file as one transaction (see 0005 and 0006). The checks that name 'once' are in 20261024061755_schedule_revision.
DO $$ BEGIN
  ALTER TYPE "bank"."transfer_cadence" ADD VALUE 'once' AFTER 'monthly';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

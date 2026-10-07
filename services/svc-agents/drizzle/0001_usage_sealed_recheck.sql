-- svc-agents · a usage insert rechecks sealed_at under the settlement lock.
-- Reversal: 0001_usage_sealed_recheck.down.sql
--
-- NOT tagged `intafaced:destructive`: it drops no table, no column and no row.
--
-- 0000 installed usage_records_reject_sealed with an unlocked SELECT. Books
-- that already applied 0000 will not run that file again, so the function has
-- to be replaced here. Fresh installs get the same body from 0000; this file
-- makes an already-applied book match.
--
-- The lock conflicts with settlement's UPDATE of the window. After it is
-- acquired, sealed_at is the value that update committed. A row that was still
-- waiting when the window sealed is refused. charged_amount is not rewritten.

CREATE OR REPLACE FUNCTION "agents"."usage_records_reject_sealed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sealed timestamptz;
BEGIN
  SELECT w."sealed_at" INTO sealed
    FROM "agents"."usage_windows" w
   WHERE w."session_id" = NEW."session_id" AND w."window_id" = NEW."window_id"
   FOR UPDATE;

  IF sealed IS NOT NULL THEN
    RAISE EXCEPTION 'usage window % for session % was settled at % and accepts no further usage',
      NEW."window_id", NEW."session_id", sealed
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

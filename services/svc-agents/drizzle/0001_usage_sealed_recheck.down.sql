-- Reversal of 0001_usage_sealed_recheck.sql.
--
-- NOT tagged `intafaced:destructive`: this drops no table, no column and no
-- row. It puts back the unlocked read. A usage insert can again commit into a
-- window whose charged_amount was sealed without that row.
--
-- It exists so the migration is provably reversible. Do not run it against a
-- database that is sealing usage windows.

CREATE OR REPLACE FUNCTION "agents"."usage_records_reject_sealed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sealed timestamptz;
BEGIN
  SELECT w."sealed_at" INTO sealed
    FROM "agents"."usage_windows" w
   WHERE w."session_id" = NEW."session_id" AND w."window_id" = NEW."window_id";

  IF sealed IS NOT NULL THEN
    RAISE EXCEPTION 'usage window % for session % was settled at % and accepts no further usage',
      NEW."window_id", NEW."session_id", sealed
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

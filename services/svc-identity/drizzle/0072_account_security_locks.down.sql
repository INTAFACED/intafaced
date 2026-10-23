-- Reverses 0072_account_security_locks.sql. Refuses while any lock is open: dropping the table would end those locks
-- silently. End or keep them first; ended history is dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "identity"."account_security_locks" WHERE "state" = 'locked') THEN
    RAISE EXCEPTION 'account_security_locks has open locks; refusing to drop it';
  END IF;
END $$;
DROP TABLE IF EXISTS "identity"."account_security_locks";

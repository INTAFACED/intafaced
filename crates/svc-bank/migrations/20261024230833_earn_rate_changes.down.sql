-- Reverses 20261024230833. Fails closed: a recorded rate is what customers were shown, so this never deletes one.
-- With no records, it drops the append-only trigger and the empty table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."earn_rate_changes") THEN
    RAISE EXCEPTION 'earn rate changes are recorded; they are the history customers read, so 20261024230833 is not reversed';
  END IF;
END $$;

DROP TRIGGER IF EXISTS "earn_rate_changes_append_only_trg" ON "bank"."earn_rate_changes";
DROP FUNCTION IF EXISTS "bank"."earn_rate_changes_append_only"();
DROP TABLE IF EXISTS "bank"."earn_rate_changes";

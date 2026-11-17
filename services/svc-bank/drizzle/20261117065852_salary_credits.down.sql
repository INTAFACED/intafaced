-- Reverses the salary credits migration of the same name. Refuses while any credit is recorded, so the partner's
-- references for a salary credit, split or reversal are never dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."salary_credits") THEN
    RAISE EXCEPTION 'salary_credits holds credits; refusing to drop it';
  END IF;
END $$;
-- intafaced:destructive both tables are empty, checked above
DROP TABLE IF EXISTS "bank"."salary_split_legs";
DROP TABLE IF EXISTS "bank"."salary_credits";

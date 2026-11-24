-- Reverses the own moves migration of the same name. Refuses while any move is recorded, so a sent move's partner
-- reference and on-chain transfers are never dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."own_moves") THEN
    RAISE EXCEPTION 'own_moves holds moves; refusing to drop it';
  END IF;
END $$;
-- intafaced:destructive the moves table is empty, checked above
DROP TABLE IF EXISTS "bank"."own_moves";

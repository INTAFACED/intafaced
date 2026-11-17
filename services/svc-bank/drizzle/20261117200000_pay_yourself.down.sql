-- Reverses the pay yourself migration of the same name. Refuses while any move is recorded, so a signed move's venue
-- nonce is never dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."pay_yourself_moves") THEN
    RAISE EXCEPTION 'pay_yourself_moves holds moves; refusing to drop it';
  END IF;
END $$;
-- intafaced:destructive the moves table is empty, checked above; a rule holds no money
DROP TABLE IF EXISTS "bank"."pay_yourself_moves";
DROP TABLE IF EXISTS "bank"."pay_yourself_rules";

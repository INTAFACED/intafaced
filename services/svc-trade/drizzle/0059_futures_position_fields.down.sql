-- Reverses 0059_futures_position_fields.sql.
-- Clears only the closed_at values this migration backfilled. Columns from 0003 stay.

UPDATE "trade"."positions" p
SET closed_at = NULL
FROM "trade"."position_closed_at_backfill" b
WHERE p.id = b.position_id
  AND p.closed_at = b.closed_at;

DROP TABLE IF EXISTS "trade"."position_closed_at_backfill";

ALTER TABLE "trade"."markets" DROP CONSTRAINT IF EXISTS "markets_contract_size_positive_ck";
ALTER TABLE "trade"."markets" DROP COLUMN IF EXISTS "contract_size";

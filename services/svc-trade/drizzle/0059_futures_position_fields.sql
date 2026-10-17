-- Futures position fields: backfill a missing closed_at from the close intent,
-- and a nullable contract size on the market. closed_at and updated_at already
-- exist (0003). This file never copies updated_at into closed_at.
-- Reversal: 0059_futures_position_fields.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by FUTPOSBE before this file was written.

ALTER TABLE "trade"."markets"
  ADD COLUMN IF NOT EXISTS "contract_size" numeric(38, 18);

ALTER TABLE "trade"."markets" DROP CONSTRAINT IF EXISTS "markets_contract_size_positive_ck";
ALTER TABLE "trade"."markets" ADD CONSTRAINT "markets_contract_size_positive_ck"
  CHECK ("contract_size" IS NULL OR "contract_size" > 0);

CREATE TABLE IF NOT EXISTS "trade"."position_closed_at_backfill" (
  "position_id" uuid PRIMARY KEY REFERENCES "trade"."positions" ("id") ON DELETE CASCADE,
  "closed_at" timestamptz NOT NULL
);

INSERT INTO "trade"."position_closed_at_backfill" ("position_id", "closed_at")
SELECT p.id, i.closed_at
FROM "trade"."positions" p
JOIN (
  SELECT "position_id", max("created_at") AS closed_at
  FROM "trade"."position_close_intents"
  GROUP BY "position_id"
) i ON i.position_id = p.id
WHERE p.status IN ('closed', 'liquidated')
  AND p.closed_at IS NULL
ON CONFLICT ("position_id") DO NOTHING;

UPDATE "trade"."positions" p
SET closed_at = b.closed_at
FROM "trade"."position_closed_at_backfill" b
WHERE p.id = b.position_id
  AND p.closed_at IS NULL;

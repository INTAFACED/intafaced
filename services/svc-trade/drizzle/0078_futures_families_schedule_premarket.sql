-- trade.futures · contract family + settle asset on the listing, owner expiry-tenor table, pre-market owner params.
-- Reversal: 0078_futures_families_schedule_premarket.down.sql
--
-- D-instruments-03 (contract families, expiry schedules, pre-market). Honest thin slice:
--
--   · `family` is linear|inverse. Dated vs perpetual is already `futures_contract_style` (0045) and is not repeated.
--     Inverse is a column value only: no inverse P&L formula exists, so the listing door refuses it
--     (`trade.inverse_family_unsupported`). Nothing here prices, margins or settles an inverse contract.
--   · `settle_asset` is the asset a futures market settles in. Every futures row that exists today settles in its
--     quote asset, so the backfill copies quote_asset (a fact of the current rows, not a chosen figure).
--   · The expiry-tenor table is an owner publication, versioned append-only. A blank table lists nothing and no job
--     reads it in this migration.
--   · Pre-market params (flat funding rate, mark clamp band) are owner numbers per market, versioned append-only.
--     No row, or a null field, is blank and refuses `trade.premarket_params_unset`; no default is written here.
--
-- Every statement is idempotent / re-runnable.

DO $$ BEGIN
  CREATE TYPE "trade"."futures_family" AS ENUM ('linear', 'inverse');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "trade"."markets"
  ADD COLUMN IF NOT EXISTS "futures_family" "trade"."futures_family",
  ADD COLUMN IF NOT EXISTS "futures_settle_asset" text;

COMMENT ON COLUMN "trade"."markets"."futures_family" IS
  'linear|inverse when kind=futures; NULL otherwise. Inverse is refused at the listing door until the owner publishes the inverse P&L formula.';
COMMENT ON COLUMN "trade"."markets"."futures_settle_asset" IS
  'Asset a futures market settles in; NULL on non-futures. Linear rows settle in quote_asset unless an owner-configured settle asset is stamped.';

-- Existing futures rows settle in their quote asset today.
UPDATE "trade"."markets"
   SET "futures_family" = 'linear', "futures_settle_asset" = "quote_asset"
 WHERE "kind" = 'futures' AND "futures_family" IS NULL AND "futures_settle_asset" IS NULL;

ALTER TABLE "trade"."markets" DROP CONSTRAINT IF EXISTS "markets_futures_family_terms_ck";
ALTER TABLE "trade"."markets" ADD CONSTRAINT "markets_futures_family_terms_ck"
  CHECK (
    (
      "kind" <> 'futures'
      AND "futures_family" IS NULL
      AND "futures_settle_asset" IS NULL
    )
    OR
    (
      "kind" = 'futures'
      AND (
        ("futures_family" IS NULL AND "futures_settle_asset" IS NULL)
        OR
        (
          "futures_family" IS NOT NULL
          AND "futures_settle_asset" IS NOT NULL
          AND length(btrim("futures_settle_asset")) > 0
        )
      )
    )
  );

COMMENT ON CONSTRAINT "markets_futures_family_terms_ck" ON "trade"."markets" IS
  'Non-futures carry no family or settle asset; a futures row carries both or neither. Blocks half-stamped contract terms.';

-- Owner expiry-tenor table. Latest version wins. No row means "no schedule published".
CREATE TABLE IF NOT EXISTS "trade"."futures_expiry_schedule" (
  version bigint PRIMARY KEY CHECK (version >= 1),
  tenors jsonb NOT NULL CHECK (jsonb_typeof(tenors) = 'array'),
  operator_id text NOT NULL,
  approver_id text NOT NULL,
  approval_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS futures_expiry_schedule_append_only ON "trade"."futures_expiry_schedule";
CREATE TRIGGER futures_expiry_schedule_append_only
  BEFORE UPDATE OR DELETE ON "trade"."futures_expiry_schedule"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

-- Owner pre-market params per market. Latest version wins. A missing row or a null field is blank.
CREATE TABLE IF NOT EXISTS "trade"."operator_premarket_params" (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  flat_funding_rate numeric(38, 18),
  mark_clamp_bps integer CHECK (mark_clamp_bps IS NULL OR mark_clamp_bps > 0),
  operator_id text NOT NULL,
  approver_id text NOT NULL,
  approval_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (market_id, version)
);

DROP TRIGGER IF EXISTS operator_premarket_params_append_only ON "trade"."operator_premarket_params";
CREATE TRIGGER operator_premarket_params_append_only
  BEFORE UPDATE OR DELETE ON "trade"."operator_premarket_params"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

-- MC-market-02: a purchase held until its refund window ends (J-more-catalogue-02 #4 to #6).
--
-- A purchase claimed while the owner's hold switch is on takes flow 'hold' and copies the refund window onto the row.
-- Its charge goes into the buyer's held pot (`marketPurchaseHold`, key market:hold:<id>), the row reads 'held', and the
-- seller sees nothing yet. Exactly one outcome follows: a refund inside the window (`marketPurchaseRefund`, key
-- market:refund:<id>:1) or a release once the window has ended (`marketPurchaseRelease`, key market:release:<id>). The
-- outcome is claimed first by one conditional update from held with no outcome, so a refund and a release can never
-- both win. A pay-through purchase (flow 'pay') keeps pending → settled exactly as before.
--
--   pending  → settled (pay) | held (hold) | rejected
--   held     → released | refunded, only after the matching outcome was claimed
--   settled, rejected, released, refunded are terminal

ALTER TABLE "market"."purchases"
  ADD COLUMN IF NOT EXISTS "flow" text NOT NULL DEFAULT 'pay',
  ADD COLUMN IF NOT EXISTS "refund_window_seconds" integer,
  ADD COLUMN IF NOT EXISTS "hold_posted_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "refund_window_ends_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "refund_requested_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "outcome" text,
  ADD COLUMN IF NOT EXISTS "outcome_tx_id" uuid,
  ADD COLUMN IF NOT EXISTS "outcome_at" timestamptz;

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_flow_ck";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_flow_ck" CHECK (
    ("flow" = 'pay' AND "refund_window_seconds" IS NULL)
    OR ("flow" = 'hold' AND "refund_window_seconds" IS NOT NULL AND "refund_window_seconds" > 0)
  );

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_outcome_ck";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_outcome_ck" CHECK ("outcome" IS NULL OR "outcome" IN ('release', 'refund'));

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_status_ck";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_status_ck" CHECK (
    "status" IN ('pending', 'settled', 'rejected', 'held', 'released', 'refunded')
  );

-- Every test below is NULL-safe: a CHECK that evaluates to NULL passes, so a nullable column is compared with
-- IS [NOT] NULL or IS NOT DISTINCT FROM, never with = alone.
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_status_fields_ck";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_status_fields_ck" CHECK (
    (
      "status" = 'pending'
      AND "ledger_tx_id" IS NULL
      AND "settled_at" IS NULL
      AND "rejection_code" IS NULL
      AND "hold_posted_at" IS NULL
      AND "refund_window_ends_at" IS NULL
      AND "outcome" IS NULL
      AND "outcome_tx_id" IS NULL
    )
    OR (
      "status" = 'settled'
      AND "flow" = 'pay'
      AND "ledger_tx_id" IS NOT NULL
      AND "settled_at" IS NOT NULL
      AND "rejection_code" IS NULL
      AND "hold_posted_at" IS NULL
      AND "outcome" IS NULL
      AND "outcome_tx_id" IS NULL
    )
    OR (
      "status" = 'rejected'
      AND "rejection_code" IS NOT NULL
      AND "ledger_tx_id" IS NULL
      AND "settled_at" IS NULL
      AND "hold_posted_at" IS NULL
      AND "outcome" IS NULL
      AND "outcome_tx_id" IS NULL
    )
    OR (
      "status" = 'held'
      AND "flow" = 'hold'
      AND "ledger_tx_id" IS NOT NULL
      AND "hold_posted_at" IS NOT NULL
      AND "refund_window_ends_at" IS NOT NULL
      AND "settled_at" IS NULL
      AND "rejection_code" IS NULL
      AND "outcome_tx_id" IS NULL
      AND "outcome_at" IS NULL
    )
    OR (
      "status" = 'released'
      AND "flow" = 'hold'
      AND "ledger_tx_id" IS NOT NULL
      AND "hold_posted_at" IS NOT NULL
      AND "refund_window_ends_at" IS NOT NULL
      AND "outcome" IS NOT DISTINCT FROM 'release'
      AND "outcome_tx_id" IS NOT NULL
      AND "outcome_at" IS NOT NULL
      AND "settled_at" IS NOT NULL
      AND "rejection_code" IS NULL
    )
    OR (
      "status" = 'refunded'
      AND "flow" = 'hold'
      AND "ledger_tx_id" IS NOT NULL
      AND "hold_posted_at" IS NOT NULL
      AND "refund_window_ends_at" IS NOT NULL
      AND "outcome" IS NOT DISTINCT FROM 'refund'
      AND "outcome_tx_id" IS NOT NULL
      AND "outcome_at" IS NOT NULL
      AND "settled_at" IS NULL
      AND "rejection_code" IS NULL
    )
  );

-- A paid row may carry an access end. A refunded row keeps the end it had, and every access read leaves it out.
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_access_until_settled_ck";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_access_until_settled_ck" CHECK (
    "access_until" IS NULL
    OR ("status" IN ('settled', 'held', 'released', 'refunded') AND "ledger_tx_id" IS NOT NULL)
  );

DROP INDEX IF EXISTS "market"."purchases_subscription_access_idx";
CREATE INDEX "purchases_subscription_access_idx"
  ON "market"."purchases" ("listing_id", "buyer_id")
  WHERE "access_until" IS NOT NULL
    AND "status" IN ('settled', 'held', 'released')
    AND "ledger_tx_id" IS NOT NULL;

-- The release sweep reads held rows by the end of their window.
CREATE INDEX IF NOT EXISTS "purchases_held_window_idx"
  ON "market"."purchases" ("refund_window_ends_at")
  WHERE "status" = 'held';

CREATE OR REPLACE FUNCTION "market"."purchases_status_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('settled', 'rejected', 'released', 'refunded') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'market.purchases % status % is terminal (attempted %)', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."ledger_tx_id" IS NOT NULL AND NEW."ledger_tx_id" IS DISTINCT FROM OLD."ledger_tx_id" THEN
    RAISE EXCEPTION 'market.purchases % ledger_tx_id cannot be cleared or replaced', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'pending'
     AND NEW."status" IS DISTINCT FROM OLD."status"
     AND NEW."status" NOT IN ('settled', 'rejected', 'held') THEN
    RAISE EXCEPTION 'market.purchases % illegal status transition pending → %', OLD."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'held'
     AND NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (
       -- IS NOT DISTINCT FROM, not =: with no outcome claimed, = yields NULL and the IF would let the change through.
       (NEW."status" = 'released' AND OLD."outcome" IS NOT DISTINCT FROM 'release')
       OR (NEW."status" = 'refunded' AND OLD."outcome" IS NOT DISTINCT FROM 'refund')
     ) THEN
    RAISE EXCEPTION 'market.purchases % illegal status transition held → % (claimed outcome %)', OLD."id", NEW."status", OLD."outcome"
      USING ERRCODE = 'check_violation';
  END IF;

  -- One outcome per held purchase: once claimed it never changes, so a refund and a release cannot both win.
  IF OLD."outcome" IS NOT NULL AND NEW."outcome" IS DISTINCT FROM OLD."outcome" THEN
    RAISE EXCEPTION 'market.purchases % outcome % is claimed', OLD."id", OLD."outcome"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."outcome_tx_id" IS NOT NULL AND NEW."outcome_tx_id" IS DISTINCT FROM OLD."outcome_tx_id" THEN
    RAISE EXCEPTION 'market.purchases % outcome_tx_id cannot be cleared or replaced', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The flow, the window and its end are the claim's and the hold's snapshot.
  IF NEW."flow" IS DISTINCT FROM OLD."flow"
     OR NEW."refund_window_seconds" IS DISTINCT FROM OLD."refund_window_seconds"
     OR (OLD."hold_posted_at" IS NOT NULL AND NEW."hold_posted_at" IS DISTINCT FROM OLD."hold_posted_at")
     OR (OLD."refund_window_ends_at" IS NOT NULL AND NEW."refund_window_ends_at" IS DISTINCT FROM OLD."refund_window_ends_at") THEN
    RAISE EXCEPTION 'market.purchases % flow and refund window are the claim snapshot', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

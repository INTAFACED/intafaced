-- svc-market · a purchase held until its refund window ends (§8.7, J-more-catalogue-02 #4 to #6)
-- Reversal: 0012_market_purchase_holds.down.sql
--
-- With the owner's refund window set, a purchase is charged into the buyer's own
-- pot for that purchase (ledger-client `marketPurchaseHold`), not paid to the
-- seller. Inside the window the buyer may ask for the whole amount back
-- (`marketPurchaseRefund`, refund 1). After it, the pot is released to the seller
-- and the house (`marketPurchaseRelease`). The amounts live on the ledger; this
-- table records which of those posts happened, never a balance.
--
-- Every statement is idempotent: this file is re-runnable.

-- The window is part of the claim: a retried claim after the owner changes the
-- setting still posts what the first claim chose (hold or direct sale).
ALTER TABLE "market"."purchases"
  ADD COLUMN IF NOT EXISTS "refund_window_seconds" integer;

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_refund_window_positive";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_refund_window_positive" CHECK (
    "refund_window_seconds" IS NULL OR "refund_window_seconds" > 0
  );

CREATE OR REPLACE FUNCTION "market"."purchases_refund_window_snapshot"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."refund_window_seconds" IS DISTINCT FROM OLD."refund_window_seconds" THEN
    RAISE EXCEPTION 'market.purchases % refund window is the immutable claim snapshot', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "purchases_refund_window_snapshot_trg" ON "market"."purchases";
CREATE TRIGGER "purchases_refund_window_snapshot_trg"
  BEFORE UPDATE ON "market"."purchases"
  FOR EACH ROW EXECUTE FUNCTION "market"."purchases_refund_window_snapshot"();

-- ── purchase_holds ─────────────────────────────────────────────────────────
-- One row per held purchase, written with the purchase's settle (the hold
-- posted). held → refunded, or held → released; both are final.
-- `refund_requested_at` is the buyer's ask, written before the refund posts, so
-- a release that runs after a crash posts the asked-for refund instead.
CREATE TABLE IF NOT EXISTS "market"."purchase_holds" (
  "purchase_id"          uuid PRIMARY KEY REFERENCES "market"."purchases"("id"),
  "listing_id"           uuid NOT NULL REFERENCES "market"."listings"("id"),
  "buyer_id"             uuid NOT NULL,
  "held_amount"          numeric(38, 18) NOT NULL
    CONSTRAINT "purchase_holds_amount_positive" CHECK ("held_amount" > 0),
  "hold_tx_id"           uuid NOT NULL,
  "held_at"              timestamptz NOT NULL,
  "window_ends_at"       timestamptz NOT NULL,
  "state"                text NOT NULL DEFAULT 'held'
    CONSTRAINT "purchase_holds_state_ck" CHECK ("state" IN ('held', 'refunded', 'released')),
  "refund_requested_at"  timestamptz,
  "refund_tx_id"         uuid,
  "refunded_at"          timestamptz,
  "release_tx_id"        uuid,
  "released_at"          timestamptz,
  CONSTRAINT "purchase_holds_window_after_hold" CHECK ("window_ends_at" > "held_at"),
  CONSTRAINT "purchase_holds_state_fields_ck" CHECK (
    (
      "state" = 'held'
      AND "refund_tx_id" IS NULL AND "refunded_at" IS NULL
      AND "release_tx_id" IS NULL AND "released_at" IS NULL
    )
    OR (
      "state" = 'refunded'
      AND "refund_requested_at" IS NOT NULL
      AND "refund_tx_id" IS NOT NULL AND "refunded_at" IS NOT NULL
      AND "release_tx_id" IS NULL AND "released_at" IS NULL
    )
    OR (
      "state" = 'released'
      AND "refund_requested_at" IS NULL
      AND "refund_tx_id" IS NULL AND "refunded_at" IS NULL
      AND "release_tx_id" IS NOT NULL AND "released_at" IS NOT NULL
    )
  )
);

-- The release job reads what is still held, oldest window first.
CREATE INDEX IF NOT EXISTS "purchase_holds_due_idx"
  ON "market"."purchase_holds" ("window_ends_at") WHERE "state" = 'held';

-- One live hold per buyer and listing: "Buy again" while held is one purchase.
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_holds_one_live_idx"
  ON "market"."purchase_holds" ("listing_id", "buyer_id") WHERE "state" = 'held';

CREATE OR REPLACE FUNCTION "market"."purchase_holds_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."purchase_id", NEW."listing_id", NEW."buyer_id", NEW."held_amount", NEW."hold_tx_id", NEW."held_at", NEW."window_ends_at")
     IS DISTINCT FROM
     ROW(OLD."purchase_id", OLD."listing_id", OLD."buyer_id", OLD."held_amount", OLD."hold_tx_id", OLD."held_at", OLD."window_ends_at") THEN
    RAISE EXCEPTION 'market.purchase_holds % hold terms are immutable', OLD."purchase_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" IN ('refunded', 'released') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'market.purchase_holds % is final (%)', OLD."purchase_id", OLD."state"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."refund_requested_at" IS NOT NULL AND NEW."refund_requested_at" IS DISTINCT FROM OLD."refund_requested_at" THEN
    RAISE EXCEPTION 'market.purchase_holds % refund ask cannot be withdrawn or moved', OLD."purchase_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."refund_requested_at" IS NOT NULL AND NEW."state" = 'released' THEN
    RAISE EXCEPTION 'market.purchase_holds % has a refund ask and cannot be released', OLD."purchase_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "purchase_holds_lock_trg" ON "market"."purchase_holds";
CREATE TRIGGER "purchase_holds_lock_trg"
  BEFORE UPDATE ON "market"."purchase_holds"
  FOR EACH ROW EXECUTE FUNCTION "market"."purchase_holds_lock"();

CREATE OR REPLACE FUNCTION "market"."purchase_holds_no_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'market.purchase_holds % cannot be deleted', OLD."purchase_id"
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS "purchase_holds_no_delete_trg" ON "market"."purchase_holds";
CREATE TRIGGER "purchase_holds_no_delete_trg"
  BEFORE DELETE ON "market"."purchase_holds"
  FOR EACH ROW EXECUTE FUNCTION "market"."purchase_holds_no_delete"();

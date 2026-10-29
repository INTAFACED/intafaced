-- svc-market · held claims that outlive a crash, and a release job one failing hold cannot stall
-- (J-more-catalogue-02 #4 to #6). Reversal: 0013_market_hold_claims.down.sql
--
-- Every statement is idempotent: this file is re-runnable.

-- ── purchase_hold_clearances ───────────────────────────────────────────────
-- A held claim's place, written once before its first hold post. Of two claims of one listing by one buyer, the one
-- cleared first goes on; a cleared claim is never rejected for the other, so a retry after its hold posted always
-- settles it. `last_post_at` is its latest hold post attempt: a pending cleared claim whose hold is absent from the
-- ledger once the in-flight bound has passed since then is released (rejected, nothing moved), so a refused or
-- abandoned hold never keeps the buyer from buying.
CREATE TABLE IF NOT EXISTS "market"."purchase_hold_clearances" (
  "purchase_id"  uuid PRIMARY KEY REFERENCES "market"."purchases"("id"),
  "cleared_at"   timestamptz NOT NULL DEFAULT now(),
  "last_post_at" timestamptz
);

CREATE OR REPLACE FUNCTION "market"."purchase_hold_clearances_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'market.purchase_hold_clearances % cannot be deleted', OLD."purchase_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF ROW(NEW."purchase_id", NEW."cleared_at") IS DISTINCT FROM ROW(OLD."purchase_id", OLD."cleared_at")
     OR (OLD."last_post_at" IS NOT NULL AND (NEW."last_post_at" IS NULL OR NEW."last_post_at" < OLD."last_post_at")) THEN
    RAISE EXCEPTION 'market.purchase_hold_clearances % only records a later post attempt', OLD."purchase_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "purchase_hold_clearances_lock_trg" ON "market"."purchase_hold_clearances";
CREATE TRIGGER "purchase_hold_clearances_lock_trg"
  BEFORE UPDATE OR DELETE ON "market"."purchase_hold_clearances"
  FOR EACH ROW EXECUTE FUNCTION "market"."purchase_hold_clearances_lock"();

-- After a failed refund or release post, the job leaves the hold until then, so one hold that keeps failing never
-- holds up the others.
ALTER TABLE "market"."purchase_holds" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz;

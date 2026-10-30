-- P-ads-merchant-06 (J-p2p-05 #1, #2): My Ads lists every ad with its state, why it is in it and since when; closing an
-- ad with an open order refuses; a closed ad is relisted as a new ad that names it; edits per person per UTC day are
-- counted against the owner's cap. No balance is stored here.
--
-- `close_reason`: why an ad is closed. `by_you` when the maker closed it, `sold_out` when what is left is under its
-- per-order minimum and no order on it is open (the release that left it so closes it). Null on ads closed before this
-- migration: they keep their status and say only "closed".
-- `status_since`: when the ad came into its present state, set by a trigger on every status change, so no path that
-- moves an ad can forget it. Ads already here start from their last update.
-- `relisted_from`: on an ad posted by relisting a closed one, the closed ad's id. A closed ad never reopens (its orders
-- keep the terms they were taken on); relisting posts a new ad through every check a new ad passes, once per closed ad.
-- `offer_edits`: one row per accepted edit, keyed by the edit's own idempotency key, so a retried edit counts once.
-- An erase deletes a person's never-traded ads: their edit rows go with them, and an ad relisted from one forgets it.
-- Reversal: 20261030125739_p2p_ad_lifecycle.down.sql
ALTER TABLE "p2p"."offers" ADD COLUMN IF NOT EXISTS "close_reason" text;
ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_close_reason_ck";
ALTER TABLE "p2p"."offers" ADD CONSTRAINT "offers_close_reason_ck"
  CHECK ("close_reason" IS NULL OR ("close_reason" IN ('by_you', 'sold_out') AND "status" = 'closed'));

ALTER TABLE "p2p"."offers" ADD COLUMN IF NOT EXISTS "status_since" timestamptz;
UPDATE "p2p"."offers" SET "status_since" = "updated_at" WHERE "status_since" IS NULL;
ALTER TABLE "p2p"."offers" ALTER COLUMN "status_since" SET DEFAULT now();
ALTER TABLE "p2p"."offers" ALTER COLUMN "status_since" SET NOT NULL;

CREATE OR REPLACE FUNCTION "p2p"."offers_status_since"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    NEW."status_since" := now();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "offers_status_since_trg" ON "p2p"."offers";
CREATE TRIGGER "offers_status_since_trg" BEFORE UPDATE OF "status" ON "p2p"."offers"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."offers_status_since"();

ALTER TABLE "p2p"."offers" ADD COLUMN IF NOT EXISTS "relisted_from" uuid REFERENCES "p2p"."offers" ("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "offers_relisted_from_uq" ON "p2p"."offers" ("relisted_from") WHERE "relisted_from" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "p2p"."offer_edits" (
  "maker_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "offer_id" uuid NOT NULL REFERENCES "p2p"."offers" ("id") ON DELETE CASCADE,
  "edit_day" date NOT NULL,
  "edited_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("maker_id", "idempotency_key")
);
CREATE INDEX IF NOT EXISTS "offer_edits_day_idx" ON "p2p"."offer_edits" ("maker_id", "edit_day");

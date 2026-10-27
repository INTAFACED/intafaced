-- P-ads-merchant-18 (J-p2p-04 #4): removing a payment method that is the only one an active sell ad can still be paid
-- with pauses that ad, once the person confirms. `offers.pause_reason` says why an ad is paused when the service paused
-- it (`method_removed`), and is cleared when the ad is paused by hand or resumed. `method_removal_pauses` is the record
-- of one removal and the outbox for the maker's notice: written in the same transaction as the removal and the pauses,
-- so the notice is owed from the commit. `handed_at` says when `p2p.offers.paused` reached the bus; while it is null the
-- sweep hands it over again (the bus and svc-notify dedupe on the instrument id). No balance is stored here.
-- Reversal: 20261025003000_p2p_method_removal_pauses.down.sql
ALTER TABLE "p2p"."offers" ADD COLUMN IF NOT EXISTS "pause_reason" text;
ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_pause_reason_ck";
ALTER TABLE "p2p"."offers" ADD CONSTRAINT "offers_pause_reason_ck"
  CHECK ("pause_reason" IS NULL OR ("pause_reason" = 'method_removed' AND "status" = 'paused'));

CREATE TABLE IF NOT EXISTS "p2p"."method_removal_pauses" (
  "instrument_id" uuid PRIMARY KEY REFERENCES "p2p"."payment_instruments" ("id"),
  "maker_id" text NOT NULL,
  "method_id" text NOT NULL,
  "offer_ids" uuid[] NOT NULL,
  "removed_at" timestamptz NOT NULL,
  "handed_at" timestamptz,
  CONSTRAINT "method_removal_pauses_offers_ck" CHECK (cardinality("offer_ids") > 0),
  CONSTRAINT "method_removal_pauses_order_ck" CHECK ("handed_at" IS NULL OR "handed_at" >= "removed_at")
);

CREATE INDEX IF NOT EXISTS "method_removal_pauses_owed_idx"
  ON "p2p"."method_removal_pauses" ("removed_at")
  WHERE "handed_at" IS NULL;

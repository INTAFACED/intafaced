-- svc-market · operator listing takedown
-- Reversal: 0008_market_listing_takedown.down.sql
--
-- Vendor archive stays `archived`. An operator takedown is a different status,
-- `taken_down`, with the reason, the actor, and the time on the same row.
-- A taken-down listing cannot return to active or archived. This file does
-- not post a ledger entry.

ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_status_ck";
ALTER TABLE "market"."listings"
  ADD CONSTRAINT "listings_status_ck" CHECK ("status" IN ('active', 'archived', 'taken_down'));

ALTER TABLE "market"."listings" ADD COLUMN IF NOT EXISTS "taken_down_reason" text;
ALTER TABLE "market"."listings" ADD COLUMN IF NOT EXISTS "taken_down_actor_id" uuid;
ALTER TABLE "market"."listings" ADD COLUMN IF NOT EXISTS "taken_down_at" timestamptz;

ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_taken_down_audit_ck";
ALTER TABLE "market"."listings"
  ADD CONSTRAINT "listings_taken_down_audit_ck" CHECK (
    (
      "status" = 'taken_down'
      AND "taken_down_reason" IS NOT NULL
      AND length(btrim("taken_down_reason")) >= 10
      AND length("taken_down_reason") <= 2000
      AND "taken_down_actor_id" IS NOT NULL
      AND "taken_down_at" IS NOT NULL
    )
    OR (
      "status" <> 'taken_down'
      AND "taken_down_reason" IS NULL
      AND "taken_down_actor_id" IS NULL
      AND "taken_down_at" IS NULL
    )
  );

CREATE OR REPLACE FUNCTION "market"."listings_taken_down_terminal"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'taken_down' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'market.listing_taken_down'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "listings_taken_down_terminal_trg" ON "market"."listings";
CREATE TRIGGER "listings_taken_down_terminal_trg"
  BEFORE UPDATE ON "market"."listings"
  FOR EACH ROW EXECUTE FUNCTION "market"."listings_taken_down_terminal"();

-- One client id, one takedown result. Replay reads this row and does not
-- consume a second approval.
CREATE TABLE IF NOT EXISTS "market"."listing_takedowns" (
  "client_request_id" text PRIMARY KEY
    CONSTRAINT "listing_takedowns_client_id_ck" CHECK (
      length(btrim("client_request_id")) > 0 AND length("client_request_id") <= 128
    ),
  "listing_id" uuid NOT NULL REFERENCES "market"."listings"("id"),
  "actor_id" uuid NOT NULL,
  "approval_id" text NOT NULL,
  "reason" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

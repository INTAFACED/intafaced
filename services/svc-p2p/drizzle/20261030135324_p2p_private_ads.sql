-- P-ads-merchant-07 (J-p2p-05 #3): public or private ads, and sharing an ad by link or QR. No balance is stored here.
--
-- `offers.visibility`: `public` ads are on the board; `private` ones are reachable only by their maker or a share link.
-- `offer_share_links`: one row per link the maker made. The token is random and only its SHA-256 is stored, so the table
-- cannot be read back into links. A link ends at `expires_at` (at most the owner's lifetime) or when it is revoked.
-- `p2p_trades.shared_from`: whether the order was taken through a share link, written once at take and never changed.
-- Reversal: 20261030135324_p2p_private_ads.down.sql
ALTER TABLE "p2p"."offers" ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'public';
ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_visibility_ck";
ALTER TABLE "p2p"."offers" ADD CONSTRAINT "offers_visibility_ck" CHECK ("visibility" IN ('public', 'private'));

CREATE TABLE IF NOT EXISTS "p2p"."offer_share_links" (
  "id" uuid PRIMARY KEY,
  "offer_id" uuid NOT NULL REFERENCES "p2p"."offers" ("id") ON DELETE CASCADE,
  "maker_id" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  CONSTRAINT "offer_share_links_order_ck" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "offer_share_links_revoked_ck" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);
CREATE INDEX IF NOT EXISTS "offer_share_links_offer_idx" ON "p2p"."offer_share_links" ("offer_id", "created_at");

ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "shared_from" boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_shared_from_fixed"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."shared_from" IS DISTINCT FROM OLD."shared_from" THEN
    RAISE EXCEPTION 'p2p_trades.shared_from is written once at take';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "p2p_trades_shared_from_fixed_trg" ON "p2p"."p2p_trades";
CREATE TRIGGER "p2p_trades_shared_from_fixed_trg" BEFORE UPDATE OF "shared_from" ON "p2p"."p2p_trades"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."p2p_trades_shared_from_fixed"();

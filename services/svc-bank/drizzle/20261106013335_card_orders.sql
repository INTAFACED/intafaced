-- J-bank-13 (BK-cissue-01 to -04): getting a card. Eligibility and cardholder terms, a use limit for single-use cards,
-- a design and delivery speed for a physical card, its delivery record and address history, and activation.
-- Nothing here holds value: a use limit is a policy, a delivery is a record of what a printer and courier said.

-- A card that has not been activated yet. Every card that already exists was usable at once, so it is activated now;
-- a physical card ordered from here and every replacement start at NULL, and an authorisation on them declines
-- `bank.card_not_active` until the person activates it.
ALTER TABLE "bank"."cards" ADD COLUMN IF NOT EXISTS "activated_at" timestamptz DEFAULT now();
-- POLICY: how many captured payments a virtual card takes before it closes itself. NULL is no limit.
ALTER TABLE "bank"."cards" ADD COLUMN IF NOT EXISTS "uses_allowed" integer;
ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_uses_allowed_positive";
ALTER TABLE "bank"."cards" ADD CONSTRAINT "cards_uses_allowed_positive" CHECK ("uses_allowed" IS NULL OR "uses_allowed" > 0);
-- The owner's design and delivery speed a physical card was ordered with, and the country the person said they live in.
ALTER TABLE "bank"."cards" ADD COLUMN IF NOT EXISTS "design_id" text;
ALTER TABLE "bank"."cards" ADD COLUMN IF NOT EXISTS "delivery_speed" text;
ALTER TABLE "bank"."cards" ADD COLUMN IF NOT EXISTS "residence_country" text;

-- One acceptance of one version of the cardholder terms per person (`consent:<userId>:<termsVersion>`): accepting again
-- finds this row. The hash is of the exact text the person was shown.
CREATE TABLE IF NOT EXISTS "bank"."card_terms_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "terms_version" text NOT NULL,
  "text_hash" text NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "card_terms_acceptances_user_version_idx" ON "bank"."card_terms_acceptances" ("user_id", "terms_version");

-- A physical card's delivery: what was ordered and what the printer and courier said since. No printer or courier is
-- connected (`hardware`), so only the stand-in printer on a test stack moves it past `ordered`.
CREATE TABLE IF NOT EXISTS "bank"."card_shipments" (
  "card_id" uuid PRIMARY KEY REFERENCES "bank"."cards" ("id"),
  "user_id" text NOT NULL,
  "state" text NOT NULL DEFAULT 'ordered' CHECK ("state" IN ('ordered', 'produced', 'shipped', 'delivered')),
  "speed" text NOT NULL,
  "estimate_days" integer NOT NULL CHECK ("estimate_days" > 0),
  "address" jsonb NOT NULL,
  "carrier" text,
  "tracking_ref" text,
  "ordered_at" timestamptz NOT NULL DEFAULT now(),
  "produced_at" timestamptz,
  "shipped_at" timestamptz,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Every change of a delivery address before print, keyed by the person's request (`ship-update:<cardId>:<requestId>`),
-- with the address it replaced: the history the card page shows.
CREATE TABLE IF NOT EXISTS "bank"."card_address_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "card_id" uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "request_id" uuid NOT NULL,
  "previous_address" jsonb NOT NULL,
  "address" jsonb NOT NULL,
  "changed_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "card_address_changes_request_idx" ON "bank"."card_address_changes" ("card_id", "request_id");

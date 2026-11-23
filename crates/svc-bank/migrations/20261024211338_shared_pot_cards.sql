-- A card linked to a shared pot (BK-acct-09, J-bank-07 #6): the pot's owner links one of their own cards so the pot's
-- holders (the owner and its contributors) can freeze it when it is lost. The card stays the owner's and spends as it
-- did; linking moves no money. Freezing, unfreezing and unlinking are rows in the pot's activity log naming who acted
-- and which card, written in the same transaction as the card's own row. A card a holder froze records it as `holder`,
-- so the owner is never told they froze it themselves.
-- Reversal: the matching .down.sql

CREATE TABLE IF NOT EXISTS "bank"."shared_pot_cards" (
  -- One card per pot, and one pot per card.
  "space_id" uuid PRIMARY KEY REFERENCES "bank"."spaces" ("id"),
  "card_id" uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "linked_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "shared_pot_cards_card_uq" UNIQUE ("card_id")
);

ALTER TABLE "bank"."shared_pot_activity" ADD COLUMN IF NOT EXISTS "card_id" uuid REFERENCES "bank"."cards" ("id");
ALTER TABLE "bank"."shared_pot_activity" DROP CONSTRAINT IF EXISTS "shared_pot_activity_kind_ck";
ALTER TABLE "bank"."shared_pot_activity" ADD CONSTRAINT "shared_pot_activity_kind_ck" CHECK (
  "kind" IN ('invited', 'cancelled', 'joined', 'declined', 'left', 'removed', 'card_linked', 'card_unlinked', 'card_frozen', 'card_unfrozen')
);

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_frozen_by_ck";
ALTER TABLE "bank"."cards" ADD CONSTRAINT "cards_frozen_by_ck" CHECK ("frozen_by" IS NULL OR "frozen_by" IN ('owner', 'holder', 'operator'));

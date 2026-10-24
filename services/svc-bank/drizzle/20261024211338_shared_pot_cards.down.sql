-- Reverses the shared pot card link: the card log rows go with it, and the log keeps its people rows. A holder's freeze
-- stays a freeze, recorded as the owner's as before.
UPDATE "bank"."cards" SET "frozen_by" = 'owner' WHERE "frozen_by" = 'holder';
ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_frozen_by_ck";
ALTER TABLE "bank"."cards" ADD CONSTRAINT "cards_frozen_by_ck" CHECK ("frozen_by" IS NULL OR "frozen_by" IN ('owner', 'operator'));
DELETE FROM "bank"."shared_pot_activity" WHERE "kind" IN ('card_linked', 'card_unlinked', 'card_frozen', 'card_unfrozen');
ALTER TABLE "bank"."shared_pot_activity" DROP CONSTRAINT IF EXISTS "shared_pot_activity_kind_ck";
ALTER TABLE "bank"."shared_pot_activity" ADD CONSTRAINT "shared_pot_activity_kind_ck" CHECK (
  "kind" IN ('invited', 'cancelled', 'joined', 'declined', 'left', 'removed')
);
ALTER TABLE "bank"."shared_pot_activity" DROP COLUMN IF EXISTS "card_id";
DROP TABLE IF EXISTS "bank"."shared_pot_cards";

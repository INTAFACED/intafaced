DROP TABLE IF EXISTS "bank"."card_address_changes";
DROP TABLE IF EXISTS "bank"."card_shipments";
DROP TABLE IF EXISTS "bank"."card_terms_acceptances";
ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_uses_allowed_positive";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "residence_country";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "delivery_speed";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "design_id";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "uses_allowed";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "activated_at";

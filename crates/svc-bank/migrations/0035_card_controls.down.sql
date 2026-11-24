DROP TABLE IF EXISTS "bank"."card_secret_audits";
DROP TABLE IF EXISTS "bank"."card_commands";

ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_channel_known";
ALTER TABLE "bank"."card_authorizations" DROP COLUMN IF EXISTS "channel";

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_replaced_by_card_fk";
ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_replaces_card_fk";
ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_replace_reason_with_successor";
ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_replace_reason";
ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_physical_has_address";
ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_card_type";
ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_cash_limit_positive";
ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_monthly_limit_positive";
ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_daily_limit_positive";

ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "replace_reason";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "replaced_by_card_id";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "replaces_card_id";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "shipping_address";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "card_type";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "channel_abroad";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "channel_atm";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "channel_contactless";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "channel_online";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "cash_limit";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "monthly_limit";
ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "daily_limit";

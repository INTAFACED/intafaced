-- Card controls the customer screens call (BANKCARDS).
--
-- Policy ceilings and channel switches live on the card. They are not balances:
-- nothing here counts down as the card is used. Spend against a ceiling is the
-- sum of approved authorisation records, which are themselves records of one
-- decision. A PAN, CVV, PIN, or wallet payload has no column. The audit table
-- records that a secret was shown or set, never the secret.
--
-- Reversal: 0035_card_controls.down.sql

ALTER TABLE "bank"."cards"
  ADD COLUMN IF NOT EXISTS "daily_limit" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "monthly_limit" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "cash_limit" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "channel_online" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "channel_contactless" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "channel_atm" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "channel_abroad" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "card_type" text NOT NULL DEFAULT 'virtual',
  ADD COLUMN IF NOT EXISTS "shipping_address" jsonb,
  ADD COLUMN IF NOT EXISTS "replaces_card_id" uuid,
  ADD COLUMN IF NOT EXISTS "replaced_by_card_id" uuid,
  ADD COLUMN IF NOT EXISTS "replace_reason" text;

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_daily_limit_positive";
ALTER TABLE "bank"."cards"
  ADD CONSTRAINT "cards_daily_limit_positive" CHECK ("daily_limit" IS NULL OR "daily_limit" > 0);

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_monthly_limit_positive";
ALTER TABLE "bank"."cards"
  ADD CONSTRAINT "cards_monthly_limit_positive" CHECK ("monthly_limit" IS NULL OR "monthly_limit" > 0);

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_cash_limit_positive";
ALTER TABLE "bank"."cards"
  ADD CONSTRAINT "cards_cash_limit_positive" CHECK ("cash_limit" IS NULL OR "cash_limit" > 0);

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_card_type";
ALTER TABLE "bank"."cards"
  ADD CONSTRAINT "cards_card_type" CHECK ("card_type" IN ('virtual', 'physical'));

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_physical_has_address";
ALTER TABLE "bank"."cards"
  ADD CONSTRAINT "cards_physical_has_address" CHECK ("card_type" <> 'physical' OR "shipping_address" IS NOT NULL);

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_replace_reason";
ALTER TABLE "bank"."cards"
  ADD CONSTRAINT "cards_replace_reason" CHECK (
    "replace_reason" IS NULL OR "replace_reason" IN ('lost', 'stolen', 'damaged')
  );

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_replace_reason_with_successor";
ALTER TABLE "bank"."cards"
  ADD CONSTRAINT "cards_replace_reason_with_successor" CHECK (
    ("replaced_by_card_id" IS NULL AND "replace_reason" IS NULL)
    OR ("replaced_by_card_id" IS NOT NULL AND "replace_reason" IS NOT NULL)
  );

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_replaces_card_fk";
ALTER TABLE "bank"."cards"
  ADD CONSTRAINT "cards_replaces_card_fk" FOREIGN KEY ("replaces_card_id") REFERENCES "bank"."cards" ("id");

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_replaced_by_card_fk";
ALTER TABLE "bank"."cards"
  ADD CONSTRAINT "cards_replaced_by_card_fk" FOREIGN KEY ("replaced_by_card_id") REFERENCES "bank"."cards" ("id");

ALTER TABLE "bank"."card_authorizations"
  ADD COLUMN IF NOT EXISTS "channel" text NOT NULL DEFAULT 'card-present';

ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_channel_known";
ALTER TABLE "bank"."card_authorizations"
  ADD CONSTRAINT "card_authorizations_channel_known" CHECK (
    "channel" IN ('card-present', 'online', 'contactless', 'atm', 'foreign')
  );

CREATE TABLE IF NOT EXISTS "bank"."card_commands" (
  "id" uuid PRIMARY KEY,
  "card_id" uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "kind" text NOT NULL,
  "payload_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "card_commands_kind" CHECK ("kind" IN ('set_limits', 'set_channels'))
);

CREATE INDEX IF NOT EXISTS "card_commands_card_idx" ON "bank"."card_commands" ("card_id", "created_at");

-- That a secret was revealed or a PIN was set. Never the secret itself.
CREATE TABLE IF NOT EXISTS "bank"."card_secret_audits" (
  "id" uuid PRIMARY KEY,
  "card_id" uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "payload_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "card_secret_audits_kind" CHECK (
    "kind" IN ('pan_reveal', 'pin_reveal', 'pin_set', 'wallet_provision')
  )
);

CREATE INDEX IF NOT EXISTS "card_secret_audits_card_idx" ON "bank"."card_secret_audits" ("card_id", "created_at");

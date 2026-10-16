-- Merchant business profile (portal settings and onboarding).
--
-- Legal name and display name already live on pay.merchants (0071). This adds the
-- rest of the business identity the merchant portal edits, plus an append-only
-- change log. Sensitive fields (legal name, address, statement descriptor,
-- industry) stay off the live row until INTAFACED compliance approves the
-- proposal. A merchant second approver is optional (`profile_second_approval`,
-- default off) and never applies those fields. Display name, website and
-- support contact apply on submit and are still logged.
--
-- No KYB vendor, no terms version, no fee and no limit is introduced here.
-- Onboarding progress is derived from these columns, the existing KYB status,
-- and payout-destination rows. A missing vendor stays "pending vendor".

ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "profile_version" bigint NOT NULL DEFAULT 0;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "website" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "support_email" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "support_phone" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "statement_descriptor" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "industry" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "address_line1" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "address_line2" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "address_city" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "address_region" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "address_postal_code" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "address_country" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "profile_second_approval" boolean NOT NULL DEFAULT false;

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_profile_version_ck";
ALTER TABLE "pay"."merchants" ADD CONSTRAINT "merchants_profile_version_ck" CHECK ("profile_version" >= 0);

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_website_ck";
ALTER TABLE "pay"."merchants" ADD CONSTRAINT "merchants_website_ck"
  CHECK ("website" IS NULL OR (
    "website" = btrim("website")
    AND char_length("website") BETWEEN 1 AND 200
    AND "website" LIKE 'https://%'
    AND position('@' in "website") = 0
    AND "website" !~ '[\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]'
  ));

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_support_email_ck";
ALTER TABLE "pay"."merchants" ADD CONSTRAINT "merchants_support_email_ck"
  CHECK ("support_email" IS NULL OR (
    "support_email" = btrim("support_email")
    AND char_length("support_email") BETWEEN 3 AND 200
    AND position('@' in "support_email") > 1
    AND "support_email" !~ '[[:space:]]'
    AND "support_email" !~ '[\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]'
  ));

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_support_phone_ck";
ALTER TABLE "pay"."merchants" ADD CONSTRAINT "merchants_support_phone_ck"
  CHECK ("support_phone" IS NULL OR (
    "support_phone" = btrim("support_phone")
    AND "support_phone" ~ '^\+?[0-9][0-9 .\-]{6,31}$'
  ));

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_statement_descriptor_ck";
ALTER TABLE "pay"."merchants" ADD CONSTRAINT "merchants_statement_descriptor_ck"
  CHECK ("statement_descriptor" IS NULL OR (
    "statement_descriptor" = btrim("statement_descriptor")
    AND char_length("statement_descriptor") BETWEEN 1 AND 120
    AND "statement_descriptor" !~ '[\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]'
  ));

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_industry_ck";
ALTER TABLE "pay"."merchants" ADD CONSTRAINT "merchants_industry_ck"
  CHECK ("industry" IS NULL OR (
    "industry" = btrim("industry")
    AND char_length("industry") BETWEEN 1 AND 120
    AND "industry" !~ '[\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]'
  ));

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_address_ck";
ALTER TABLE "pay"."merchants" ADD CONSTRAINT "merchants_address_ck"
  CHECK (
    (
      "address_line1" IS NULL AND "address_line2" IS NULL AND "address_city" IS NULL
      AND "address_region" IS NULL AND "address_postal_code" IS NULL AND "address_country" IS NULL
    )
    OR (
      "address_line1" IS NOT NULL AND "address_city" IS NOT NULL
      AND "address_postal_code" IS NOT NULL AND "address_country" IS NOT NULL
      AND "address_country" ~ '^[A-Z]{2}$'
    )
  );

CREATE TABLE IF NOT EXISTS "pay"."merchant_profile_changes" (
  "request_id"       uuid PRIMARY KEY,
  "seq"              bigserial NOT NULL,
  "merchant_id"      uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "status"           text NOT NULL
    CONSTRAINT "merchant_profile_changes_status_known"
    CHECK ("status" IN ('applied', 'pending', 'pending_review', 'rejected', 'conflict')),
  "before_profile"   jsonb NOT NULL,
  "after_profile"    jsonb NOT NULL,
  "sensitive_keys"   jsonb NOT NULL,
  "change_hash"      text NOT NULL
    CONSTRAINT "merchant_profile_changes_hash_not_blank" CHECK (length(btrim("change_hash")) > 0),
  "expected_version" bigint NOT NULL,
  "maker_id"         text NOT NULL
    CONSTRAINT "merchant_profile_changes_maker_not_blank" CHECK (length(btrim("maker_id")) > 0),
  "checker_id"       text,
  "second_approver_id" text,
  "reason"           text NOT NULL
    CONSTRAINT "merchant_profile_changes_reason_not_blank" CHECK (length(btrim("reason")) >= 3),
  "checker_reason"   text,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "decided_at"       timestamptz,
  CONSTRAINT "merchant_profile_changes_maker_not_checker"
    CHECK ("checker_id" IS NULL OR "checker_id" <> "maker_id"),
  CONSTRAINT "merchant_profile_changes_maker_not_second"
    CHECK (
      "second_approver_id" IS NULL
      OR (length(btrim("second_approver_id")) > 0 AND "second_approver_id" <> "maker_id")
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_profile_changes_seq_idx"
  ON "pay"."merchant_profile_changes" ("seq");
CREATE INDEX IF NOT EXISTS "merchant_profile_changes_merchant_idx"
  ON "pay"."merchant_profile_changes" ("merchant_id", "created_at" DESC, "request_id" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_profile_changes_one_open"
  ON "pay"."merchant_profile_changes" ("merchant_id")
  WHERE "status" IN ('pending', 'pending_review');

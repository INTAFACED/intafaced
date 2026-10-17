-- W4b merchant names: a name a human can read for every merchant.
--
-- Until now a merchant was only a UUID, so the founder Merchants panel could show
-- nothing else. Two optional text columns, both written ONLY by the merchant's own
-- onboarding call (`merchant.create`, keyed on the signed-in principal) and read by
-- the founder panel:
--   display_name — the trading name shown in lists and headings.
--   legal_name   — the registered business name, as the merchant typed it.
--
-- Additive and nullable on purpose. No backfill: a merchant that existed before
-- this migration stays NULL (the panel says "Unnamed merchant"); inventing a name
-- from a user id or a settlement preference would be a made-up fact about a business.
--
-- Shape rules (also enforced by the service before it writes): after trimming
-- spaces the value is 1..120 characters, and it holds no control character
-- (C0 range, DEL or C1 range) and no invisible formatting character (U+061C, U+200B,
-- U+200E, U+200F, U+2028, U+2029, U+202A-U+202E, U+2060, U+2066-U+2069, U+FEFF), so a
-- name cannot carry a newline, tab, terminal escape or text-direction trick into a
-- table, a CSV export or a log line. U+200D (zero-width joiner) stays allowed for emoji.
-- The stored value must also equal its btrim(): leading and trailing spaces are refused,
-- so the 1..120 bound is on the real stored length.

ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "display_name" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "legal_name" text;

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_display_name_ck";
ALTER TABLE "pay"."merchants" ADD CONSTRAINT "merchants_display_name_ck"
  CHECK ("display_name" IS NULL OR (
    "display_name" = btrim("display_name") AND char_length("display_name") BETWEEN 1 AND 120 AND "display_name" !~ '[\x01-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]'
  ));

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_legal_name_ck";
ALTER TABLE "pay"."merchants" ADD CONSTRAINT "merchants_legal_name_ck"
  CHECK ("legal_name" IS NULL OR (
    "legal_name" = btrim("legal_name") AND char_length("legal_name") BETWEEN 1 AND 120 AND "legal_name" !~ '[\x01-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]'
  ));

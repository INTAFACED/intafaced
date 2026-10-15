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
-- (C0 range, DEL or C1 range), so a name cannot carry a newline, tab or terminal
-- escape into a table, a CSV export or a log line.

ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "display_name" text;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "legal_name" text;

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_display_name_ck";
ALTER TABLE "pay"."merchants" ADD CONSTRAINT "merchants_display_name_ck"
  CHECK ("display_name" IS NULL OR (char_length(btrim("display_name")) BETWEEN 1 AND 120 AND "display_name" !~ '[\x01-\x1f\x7f-\x9f]'));

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_legal_name_ck";
ALTER TABLE "pay"."merchants" ADD CONSTRAINT "merchants_legal_name_ck"
  CHECK ("legal_name" IS NULL OR (char_length(btrim("legal_name")) BETWEEN 1 AND 120 AND "legal_name" !~ '[\x01-\x1f\x7f-\x9f]'));

-- Reverses 20261109124500_api_key_kind.sql: every key reads as a person's own key again.
ALTER TABLE "identity"."api_keys" DROP COLUMN IF EXISTS "kind";

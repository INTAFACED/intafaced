-- Reverses 0050_social_identities.sql. Linked provider identities are dropped; the
-- account keeps its own sign-in methods.
DROP TABLE IF EXISTS "identity"."social_flows";
DROP INDEX IF EXISTS "identity"."social_identities_user_provider_idx";
DROP TABLE IF EXISTS "identity"."social_identities";
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "password_set";

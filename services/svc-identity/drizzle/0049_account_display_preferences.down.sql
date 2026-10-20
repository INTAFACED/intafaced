-- Reverses 0049_account_display_preferences.sql: the display choice is a copy the
-- device can rebuild, so its rows are dropped before the narrower check returns.
DELETE FROM "identity"."user_preferences" WHERE "namespace" = 'account.display';
ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" = 'trade.views');

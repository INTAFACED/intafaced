-- Preferences gain a second namespace, account.display (language and display
-- currency), so a choice made on one device follows the account.
-- Reversal: 0049_account_display_preferences.down.sql

ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display'));

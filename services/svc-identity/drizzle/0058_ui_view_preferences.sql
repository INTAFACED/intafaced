-- Preferences gain a third namespace, ui.view (layout mode, hide balances, display currency, theme,
-- active profile), so the Simple/Pro choice and the other view settings follow the account.
-- Reversal: 0058_ui_view_preferences.down.sql

ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view'));

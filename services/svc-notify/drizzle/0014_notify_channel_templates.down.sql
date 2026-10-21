DROP TRIGGER IF EXISTS message_templates_append_only ON notify.message_templates;
DROP TRIGGER IF EXISTS channel_settings_history_append_only ON notify.channel_settings_history;
DROP FUNCTION IF EXISTS notify.append_only();
DROP TABLE IF EXISTS "notify"."message_templates";
DROP TABLE IF EXISTS "notify"."channel_settings_history";
DROP TABLE IF EXISTS "notify"."channel_settings";

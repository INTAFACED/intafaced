-- intafaced:destructive — reversal of 0119_pay_custody_deposit_setting_edits.sql (drops the audit trail; for CI proof of reversibility)
DROP TRIGGER IF EXISTS "custody_deposit_setting_events_append_only_trg" ON "pay"."custody_deposit_setting_events";
DROP FUNCTION IF EXISTS "pay"."custody_deposit_setting_events_append_only"();
DROP TABLE IF EXISTS "pay"."custody_deposit_setting_events";
ALTER TABLE "pay"."custody_deposit_settings" DROP CONSTRAINT IF EXISTS "custody_deposit_settings_halt_note_ck";
ALTER TABLE "pay"."custody_deposit_settings" DROP COLUMN IF EXISTS "halt_note";
ALTER TABLE "pay"."custody_deposit_settings" DROP COLUMN IF EXISTS "version";

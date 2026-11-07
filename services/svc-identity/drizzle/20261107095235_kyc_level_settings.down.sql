-- Reverses edited per-level settings: every level reads the owner's published values again.
DROP TABLE IF EXISTS "identity"."kyc_level_setting_changes";
DROP TABLE IF EXISTS "identity"."kyc_level_settings";

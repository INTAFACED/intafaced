-- intafaced:destructive — reversal of 20261112003000_public_settings_app_store.sql
--
-- Lossy by nature: the store link is dropped. Its change log rows keep the value in their before and after.
ALTER TABLE ops.public_settings DROP COLUMN IF EXISTS app_store_url;

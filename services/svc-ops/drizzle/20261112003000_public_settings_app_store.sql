-- svc-ops · the app's store link on the owner-set public settings (SP-pages-03)
-- Reversal: 20261112003000_public_settings_app_store.down.sql
--
-- NULL until a founder sets it: no store address is built in, and /app says there is no store app while it is blank.
-- The contract accepts only an https link; the check here holds the length.
ALTER TABLE ops.public_settings
 ADD COLUMN app_store_url text CHECK (app_store_url IS NULL OR char_length(app_store_url) BETWEEN 9 AND 300);

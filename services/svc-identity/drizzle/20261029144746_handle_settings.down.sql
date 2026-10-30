-- Reverses 20261029144746_handle_settings.sql. Handles already changed stay as they are; only the counter, the
-- discoverability choice, the retired list and the audit go.
DROP TABLE IF EXISTS "identity"."retired_handles";
DROP TABLE IF EXISTS "identity"."handle_audit";
ALTER TABLE "identity"."users" DROP CONSTRAINT IF EXISTS "users_handle_changes_ck";
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "handle_changes";
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "handle_discoverable";

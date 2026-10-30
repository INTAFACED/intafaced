-- Reverses 20261029140000_developer_sandboxes.sql. Sandbox keys already made stay as keys; only their sandbox link,
-- the sandboxes and the environment lock go.
DROP TRIGGER IF EXISTS "api_keys_mode_immutable" ON "identity"."api_keys";
DROP FUNCTION IF EXISTS "identity"."api_keys_mode_immutable"();
DROP TABLE IF EXISTS "identity"."developer_sandbox_keys";
DROP TABLE IF EXISTS "identity"."developer_sandboxes";

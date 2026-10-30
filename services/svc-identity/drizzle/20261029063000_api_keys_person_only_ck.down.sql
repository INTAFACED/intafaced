-- Reverses 20261029063000_api_keys_person_only_ck.sql: the CHECK goes back to the 0045 list.
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_no_withdraw_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_no_withdraw_ck"
  CHECK (NOT ("scopes" && ARRAY['trade:withdraw', 'admin:treasury', 'bank:card', 'admin:read', 'admin:write', 'admin:compliance', 'support:ops', 'market:ops']));

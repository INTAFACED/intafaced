-- Reverses 20261029203500_api_keys_desk_lookup_ck.sql: the CHECK goes back to the 20261029063000 list.
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_no_withdraw_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_no_withdraw_ck"
  CHECK (NOT ("scopes" && ARRAY['trade:withdraw', 'admin:treasury', 'bank:card', 'admin:read', 'admin:write', 'admin:compliance', 'support:ops', 'market:ops', 'agents:execute']));

-- The api_keys insert backstop also refuses agents:execute (OWNER 107, 29 Oct 2026): running an agent spends the
-- person's own money, so it is issued to their own session and never stored on a key. assertKeyScopesAllowed,
-- requireScope and the developer-keys room refuse it in code; this CHECK is the backstop (§9). No key has ever held it:
-- no session carried the scope before this change. Reversal: 20261029063000_api_keys_person_only_ck.down.sql.

ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_no_withdraw_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_no_withdraw_ck"
  CHECK (NOT ("scopes" && ARRAY['trade:withdraw', 'admin:treasury', 'bank:card', 'admin:read', 'admin:write', 'admin:compliance', 'support:ops', 'market:ops', 'agents:execute']));

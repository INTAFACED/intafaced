-- The api_keys insert backstop also refuses support:lookup and campaigns:ops. Both are interactive-only desk scopes
-- (INTERACTIVE_ONLY_SCOPES): assertDelegatableScopes and requireScope refuse them on a key in code; this CHECK is the
-- backstop (§9), as for the other desk scopes. campaigns:ops was missing from the list; support:lookup is new. No key
-- holds either: the service has never written one to a key. Reversal: 20261029203500_api_keys_desk_lookup_ck.down.sql.

ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_no_withdraw_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_no_withdraw_ck"
  CHECK (NOT ("scopes" && ARRAY['trade:withdraw', 'admin:treasury', 'bank:card', 'admin:read', 'admin:write', 'admin:compliance', 'support:ops', 'support:lookup', 'market:ops', 'campaigns:ops', 'agents:execute']));

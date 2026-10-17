-- Align api_keys DB backstop with INTERACTIVE_ONLY_SCOPES.
-- Founder and operator desk scopes stay on an interactive session. A leaked
-- key must not store admin:read, admin:write, admin:compliance, support:ops
-- or market:ops. Service assertDelegatableScopes already refuses them;
-- requireScope refuses a key that already carries one (scope.interactive_only).
-- This CHECK is the insert backstop (§9).
-- Reversal: 0036_api_keys_desk_scopes_ck.down.sql. No balances.

ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_no_withdraw_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_no_withdraw_ck"
  CHECK (NOT ("scopes" && ARRAY['trade:withdraw', 'admin:treasury', 'bank:card', 'pay:payout', 'admin:read', 'admin:write', 'admin:compliance', 'support:ops', 'market:ops']));

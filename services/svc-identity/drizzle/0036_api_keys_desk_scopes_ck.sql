-- Align the api_keys DB backstop with the value-off-platform scopes and the
-- founder/operator desk scopes. pay:onboard is interactive-only in code
-- (#4897) and is refused by assertDelegatableScopes and requireScope. Main
-- shipped no CHECK for it, so this constraint does not add one.
-- A leaked key must not store admin:read, admin:write, admin:compliance,
-- support:ops or market:ops. requireScope refuses a key that already carries
-- one (scope.interactive_only). This CHECK is the insert backstop (§9).
-- Reversal: 0036_api_keys_desk_scopes_ck.down.sql. No balances.

ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_no_withdraw_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_no_withdraw_ck"
  CHECK (NOT ("scopes" && ARRAY['trade:withdraw', 'admin:treasury', 'bank:card', 'pay:payout', 'admin:read', 'admin:write', 'admin:compliance', 'support:ops', 'market:ops']));

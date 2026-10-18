-- intafaced:destructive — drops pay step-up proofs and mint audit, and puts pay:payout back on the API-key CHECK.
-- Keys that stored pay:payout lose that scope before the CHECK returns. Forward migration: 0045_pay_step_up.sql

DROP TABLE IF EXISTS "identity"."pay_step_up_mints";
DROP TABLE IF EXISTS "identity"."pay_step_up_proofs";

UPDATE "identity"."api_keys" SET "scopes" = array_remove("scopes", 'pay:payout') WHERE "scopes" && ARRAY['pay:payout'];

ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_no_withdraw_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_no_withdraw_ck"
  CHECK (NOT ("scopes" && ARRAY['trade:withdraw', 'admin:treasury', 'bank:card', 'pay:payout', 'admin:read', 'admin:write', 'admin:compliance', 'support:ops', 'market:ops']));

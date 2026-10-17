ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_no_withdraw_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_no_withdraw_ck"
  CHECK (NOT ("scopes" && ARRAY['trade:withdraw', 'admin:treasury', 'bank:card', 'pay:payout']));

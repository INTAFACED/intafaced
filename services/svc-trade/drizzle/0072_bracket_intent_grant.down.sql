-- intafaced:destructive — reversal of 0072_bracket_intent_grant.sql
ALTER TABLE "trade"."order_bracket_intent"
  DROP CONSTRAINT IF EXISTS "order_bracket_intent_grant_ck",
  DROP COLUMN IF EXISTS "grant_expires_at",
  DROP COLUMN IF EXISTS "grant_claims";

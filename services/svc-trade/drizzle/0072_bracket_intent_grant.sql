-- trade.order_bracket_intent · the place grant that lets a resting bracket entry place its exit later
-- Reversal: 0072_bracket_intent_grant.down.sql
--
-- A resting bracket entry fills on someone else's request, when no caller identity exists. The caller's own
-- claims (scopes, session, tier; never a token or secret) are stored with the intent, exactly as a TWAP stores
-- its place grant, and they expire with the caller's credential (`grant_expires_at`). A row without a grant is a
-- bracket whose entry resolved inside the request.

ALTER TABLE "trade"."order_bracket_intent"
  ADD COLUMN IF NOT EXISTS "grant_claims"     jsonb,
  ADD COLUMN IF NOT EXISTS "grant_expires_at" timestamptz,
  ADD CONSTRAINT "order_bracket_intent_grant_ck" CHECK (("grant_claims" IS NULL) = ("grant_expires_at" IS NULL));

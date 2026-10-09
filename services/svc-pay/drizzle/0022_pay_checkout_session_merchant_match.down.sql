-- intafaced:destructive — reversal of 0022_pay_checkout_session_merchant_match.sql
--
-- Drops the trigger that refuses a checkout session whose link merchant or
-- payment merchant disagrees with checkout_sessions.merchant_id, and the
-- function that trigger calls. The checkout_sessions table and its foreign
-- keys stay. Stored amounts, currencies, and rails stay as they are.

DROP TRIGGER IF EXISTS "checkout_sessions_merchant_match_trg" ON "pay"."checkout_sessions";
DROP FUNCTION IF EXISTS "pay"."checkout_sessions_merchant_match"();

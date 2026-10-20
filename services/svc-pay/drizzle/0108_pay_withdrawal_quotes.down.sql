-- intafaced:destructive — reversal of 0108_pay_withdrawal_quotes.sql
--
-- Drops the stored withdrawal quotes, their acceptances and the quote policy history. No balance lives in these tables
-- (a quote moves nothing); this is for CI proof of reversibility and a database that stored no real quote.

DROP TRIGGER IF EXISTS "withdrawal_quote_acceptances_append_only_trg" ON "pay"."withdrawal_quote_acceptances";
DROP TRIGGER IF EXISTS "withdrawal_quotes_append_only_trg" ON "pay"."withdrawal_quotes";
DROP TRIGGER IF EXISTS "withdrawal_quote_policy_events_append_only_trg" ON "pay"."withdrawal_quote_policy_events";
DROP FUNCTION IF EXISTS "pay"."withdrawal_quotes_append_only"();
DROP INDEX IF EXISTS "pay"."withdrawal_quote_acceptances_user_ref_uq";
DROP TABLE IF EXISTS "pay"."withdrawal_quote_acceptances";
DROP INDEX IF EXISTS "pay"."withdrawal_quotes_user_ref_uq";
DROP TABLE IF EXISTS "pay"."withdrawal_quotes";
DROP TABLE IF EXISTS "pay"."withdrawal_quote_policy_events";

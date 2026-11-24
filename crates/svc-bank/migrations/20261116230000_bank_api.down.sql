-- Reverses 20261116230000_bank_api.sql. These tables hold the bank API's intent rows, the transfer states the partner
-- reported and the person's webhook endpoints. Never a balance: every move and payment they name is the partner's, on the
-- partner's own record under the same business key, so dropping them loses no record of where money is.

-- intafaced:destructive the bank API tables this migration added, whose moves and payments the partner bank holds the record of
DROP TABLE IF EXISTS "bank"."api_webhook_deliveries";
DROP TABLE IF EXISTS "bank"."api_webhook_endpoints";
DROP TABLE IF EXISTS "bank"."api_transfer_events";
DROP TABLE IF EXISTS "bank"."api_payments";
DROP TABLE IF EXISTS "bank"."api_moves";
DROP TABLE IF EXISTS "bank"."api_move_quotes";

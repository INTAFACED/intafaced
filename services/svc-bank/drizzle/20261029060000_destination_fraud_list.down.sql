-- intafaced:destructive — reversal of 20261029060000_destination_fraud_list.sql. Dropping these tables forgets every
-- listed fraud address and who listed it, so saved addresses are no longer checked against the list.
DROP TRIGGER IF EXISTS "destination_fraud_list_history_append_only_trg" ON "bank"."destination_fraud_list_history";
DROP FUNCTION IF EXISTS "bank"."destination_fraud_list_history_append_only"();
DROP TABLE IF EXISTS "bank"."destination_fraud_list_history";
DROP TABLE IF EXISTS "bank"."destination_fraud_list";

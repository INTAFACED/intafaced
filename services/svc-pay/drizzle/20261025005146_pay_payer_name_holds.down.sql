-- intafaced:destructive — reversal of 20261025005146_pay_payer_name_holds.sql
--
-- Drops the names payers gave for bank transfers and every payer-name hold. A payment that was held stays `created`
-- with nothing captured; its bank transfer is no longer checked by name.

DROP TRIGGER IF EXISTS "payer_name_holds_kept_trg" ON "pay"."payer_name_holds";
DROP FUNCTION IF EXISTS "pay"."payer_name_holds_kept"();
DROP TRIGGER IF EXISTS "payer_names_kept_trg" ON "pay"."payer_names";
DROP FUNCTION IF EXISTS "pay"."payer_names_kept"();
DROP TABLE IF EXISTS "pay"."payer_name_holds";
DROP TABLE IF EXISTS "pay"."payer_names";

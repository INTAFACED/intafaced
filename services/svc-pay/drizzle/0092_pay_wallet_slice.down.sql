-- intafaced:destructive — reversal of 0092_pay_wallet_slice.sql
--
-- Drops the wallet slice tables. Stored rows go with the tables.

DROP TABLE IF EXISTS "pay"."wallet_withdrawals";
DROP TABLE IF EXISTS "pay"."wallet_inbounds";

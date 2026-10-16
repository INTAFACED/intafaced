-- intafaced:destructive — reversal of 0074_pay_limit_requests.sql
--
-- Drops stored limit-increase requests. They never changed caps, profiles or the ledger.

DROP TRIGGER IF EXISTS "control_limit_requests_append_only_trg" ON "pay"."control_limit_requests";
DROP TABLE IF EXISTS "pay"."control_limit_requests";

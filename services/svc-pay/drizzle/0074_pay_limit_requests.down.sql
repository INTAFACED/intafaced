-- intafaced:destructive — reversal of 0074_pay_limit_requests.sql
--
-- Drops stored limit-increase requests. They never changed caps, profiles or the ledger.
-- Does not drop pay.control_append_only: other control tables still use it.

DROP TRIGGER IF EXISTS "control_limit_requests_append_only_trg" ON "pay"."control_limit_requests";
DROP TRIGGER IF EXISTS "control_limit_requests_close_once_trg" ON "pay"."control_limit_requests";
DROP FUNCTION IF EXISTS "pay"."control_limit_requests_close_once"();
DROP TABLE IF EXISTS "pay"."control_limit_requests";

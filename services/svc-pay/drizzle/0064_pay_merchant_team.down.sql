-- intafaced:destructive — reversal of 0064_pay_merchant_team.sql
--
-- Drops the team roster and the only record of who changed whose role. The
-- merchant owner (pay.merchants.user_id) is untouched, so every merchant keeps
-- an owner; invited and active teammates lose access.

DROP TRIGGER IF EXISTS "merchant_team_events_append_only_trg" ON "pay"."merchant_team_events";
DROP TABLE IF EXISTS "pay"."merchant_team_events";
DROP FUNCTION IF EXISTS "pay"."merchant_team_events_append_only"();
DROP TABLE IF EXISTS "pay"."merchant_team_members";

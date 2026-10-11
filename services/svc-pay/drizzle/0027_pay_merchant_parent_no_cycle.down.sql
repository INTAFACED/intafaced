-- intafaced:destructive — reversal of 0027_pay_merchant_parent_no_cycle.sql
--
-- Drops the trigger that refuses a parent cycle of any length, and the
-- function it calls. merchants_parent_not_self stays, so a merchant still
-- cannot be its own parent. Stored rows stay. This reversal moves no value.

DROP TRIGGER IF EXISTS "merchants_parent_no_cycle_trg" ON "pay"."merchants";
DROP FUNCTION IF EXISTS "pay"."merchants_parent_no_cycle"();

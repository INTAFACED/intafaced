-- Reverses 20261030150000_account_appeals_staff_freeze.sql. Staff-freeze appeals go with it.
DELETE FROM "identity"."account_appeals" WHERE "restriction" = 'staff_freeze';
ALTER TABLE "identity"."account_appeals" DROP CONSTRAINT IF EXISTS "account_appeals_restriction_ck";
ALTER TABLE "identity"."account_appeals"
  ADD CONSTRAINT "account_appeals_restriction_ck" CHECK ("restriction" IN ('trading_restricted'));

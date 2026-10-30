-- A staff freeze can be appealed too (I-account-lifecycle-12, J-identity-11 #5): filed signed out, since a staff-frozen
-- account cannot sign in. Its `restriction_ref` is `staff_freeze:<identity_control_version>`.
-- Reversal: 20261030150000_account_appeals_staff_freeze.down.sql
ALTER TABLE "identity"."account_appeals" DROP CONSTRAINT IF EXISTS "account_appeals_restriction_ck";
ALTER TABLE "identity"."account_appeals"
  ADD CONSTRAINT "account_appeals_restriction_ck" CHECK ("restriction" IN ('trading_restricted', 'staff_freeze'));

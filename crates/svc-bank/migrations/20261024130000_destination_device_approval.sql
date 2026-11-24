-- W-withdraw-09 (J-wallet-04 #5): a new withdrawal address can also be approved from another signed-in device.
--
-- A saved address-book entry records the sign-in (`saved_fam`, the access token's session family, the same across
-- refreshes) and the trusted device (`saved_dev`) it was saved from, as the token named them; either is null when the
-- token named none. Approving from a device is taken only when both tokens name a trusted device, they differ, and
-- svc-identity says the approving device is still trusted (by sign-up or an approval, with the new-device check on).
-- Unknown is never a match, so an entry saved before this, or from a token with no device, is approved by the emailed
-- link only.
-- Reversal: 20261024130000_destination_device_approval.down.sql

ALTER TABLE "bank"."user_withdraw_destinations"
  ADD COLUMN IF NOT EXISTS "saved_fam" uuid,
  ADD COLUMN IF NOT EXISTS "saved_dev" uuid;

ALTER TABLE "bank"."user_withdraw_destinations"
  DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_approved_by_ck",
  ADD CONSTRAINT "user_withdraw_destinations_approved_by_ck" CHECK ("approved_by" IS NULL OR "approved_by" IN ('link', 'device'));

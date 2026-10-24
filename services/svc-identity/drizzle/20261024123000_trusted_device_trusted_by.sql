-- svc-identity · how each trusted device came to be trusted, for the internal trusted-device read
-- (`GET /internal/trusted-devices/:userId/:deviceId`). Reversal: the .down.sql of the same name.
--
-- `sign-up`: the device the account was made on. `approval`: approved by the mailed code or from another trusted device.
-- `sign-in`: trusted as it signed in while the new-device check was off, which anyone holding the account's factors could
-- do. Rows from before this column was added are not known to have been proved, so they read `sign-in`.
ALTER TABLE "identity"."trusted_devices" ADD COLUMN IF NOT EXISTS "trusted_by" text NOT NULL DEFAULT 'sign-in';
ALTER TABLE "identity"."trusted_devices" DROP CONSTRAINT IF EXISTS "trusted_devices_trusted_by_check";
ALTER TABLE "identity"."trusted_devices"
  ADD CONSTRAINT "trusted_devices_trusted_by_check" CHECK ("trusted_by" IN ('sign-up', 'sign-in', 'approval'));

-- A staff close with a grace date (J-identity-14 #1). close_grace_until is set by a staff close that carries graceDays,
-- with closed_reason, while users.status stays 'active': until the date the person signs in and withdraws, and identity
-- refuses every fresh svc-trade operation. The grace closure job closes the account after the date once the closure
-- checks are clean, and clears the column. Reversal: 20261113090000_staff_close_grace.down.sql

ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "close_grace_until" timestamptz;
ALTER TABLE "identity"."users" DROP CONSTRAINT IF EXISTS "users_close_grace_check";
ALTER TABLE "identity"."users"
  ADD CONSTRAINT "users_close_grace_check" CHECK ("close_grace_until" IS NULL OR ("status" <> 'closed' AND "closed_reason" IS NOT NULL));

-- svc-identity · a phone number as a way to name the account at sign-in (J-identity-02 #1, I-account-lifecycle-07).
-- `signin_phones` holds the one number an account signs in with, beside its password, after the owner typed back the
-- code texted to it. It is not the contact phone (`user_phones`) nor the payee phone on `users`. A number names one
-- account only. A link code is an `auth_flows` row of kind `phone_link`: the subject is the number, the code is
-- stored as its SHA-256, wrong codes count in `attempts`, and it is spent once the number is linked.
-- Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."signin_phones" (
  "user_id"   uuid PRIMARY KEY REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "phone"     text NOT NULL UNIQUE CHECK ("phone" ~ '^\+[1-9][0-9]{6,14}$'),
  "linked_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "identity"."auth_flows" DROP CONSTRAINT IF EXISTS "auth_flows_kind_check";
ALTER TABLE "identity"."auth_flows"
  ADD CONSTRAINT "auth_flows_kind_check"
  CHECK ("kind" IN ('password_reset', 'handle_recovery', 'signup', 'login_code', 'new_device', 'wallet_link', 'wallet_signin', 'phone_link'));

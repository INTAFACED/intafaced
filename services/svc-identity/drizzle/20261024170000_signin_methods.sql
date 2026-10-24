-- svc-identity · link and unlink sign-in methods (I-account-lifecycle-07). `wallet_identities` holds the wallets an
-- account signs in with, proved by an EIP-4361 signature (externally owned accounts only; no chain call). A wallet
-- signs in one account only. `email_code_signin` is the account's choice to sign in by a mailed code; on for every
-- existing account, which signs in exactly as before. A wallet challenge is an `auth_flows` row of kind `wallet_link`
-- or `wallet_signin`: the subject is the wallet, the code is the message nonce, and it is spent on its first answer.
-- Reversal: the .down.sql of the same name.
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "email_code_signin" boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "identity"."wallet_identities" (
  "address" text PRIMARY KEY CHECK ("address" ~ '^0x[0-9a-f]{40}$'),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "wallet_identities_user_idx" ON "identity"."wallet_identities" ("user_id");

ALTER TABLE "identity"."auth_flows" DROP CONSTRAINT IF EXISTS "auth_flows_kind_check";
ALTER TABLE "identity"."auth_flows"
  ADD CONSTRAINT "auth_flows_kind_check"
  CHECK ("kind" IN ('password_reset', 'handle_recovery', 'signup', 'login_code', 'new_device', 'wallet_link', 'wallet_signin'));

-- W-withdraw-09 (J-wallet-04 #5): a new withdrawal address waits for the customer's approval before its cooling-off starts.
--
-- A saved address-book entry now starts `pending`. The customer approves it by an emailed single-use link; it becomes
-- `cooling` and its cooling-off runs from the approval (`updated_at`). Approval from another signed-in device comes later
-- (`approved_by` will gain its value then). Entries saved before this keep their state.
--
-- One approval link per request: only the newest mailed link of an entry works, until it expires or is used. The token
-- is kept only as its sha256 (hex); identity mails the token and never this table. `mailed_at` is set once identity took
-- the mail; a link whose mail was refused is never newest, and its token was never sent anywhere.
-- Reversal: 20261024100000_destination_approvals.down.sql

ALTER TABLE "bank"."user_withdraw_destinations"
  ADD COLUMN IF NOT EXISTS "approved_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "approved_by" text;

ALTER TABLE "bank"."user_withdraw_destinations"
  ADD CONSTRAINT "user_withdraw_destinations_approved_by_ck" CHECK ("approved_by" IS NULL OR "approved_by" IN ('link')),
  ADD CONSTRAINT "user_withdraw_destinations_approved_ck" CHECK (("approved_at" IS NULL) = ("approved_by" IS NULL));

CREATE TABLE IF NOT EXISTS "bank"."destination_approval_links" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        text NOT NULL,
  -- No foreign key, like the removal log: a link to an entry the customer removed approves nothing (the entry is gone).
  "destination_id" uuid NOT NULL,
  "seq"            integer NOT NULL,
  "token_hash"     text NOT NULL,
  "expires_at"     timestamptz NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "mailed_at"      timestamptz,
  "mail_id"        uuid,
  "used_at"        timestamptz,
  CONSTRAINT "destination_approval_links_seq_ck" CHECK ("seq" >= 1),
  CONSTRAINT "destination_approval_links_hash_ck" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "destination_approval_links_expiry_ck" CHECK ("expires_at" > "created_at")
);
CREATE UNIQUE INDEX IF NOT EXISTS "destination_approval_links_token_idx" ON "bank"."destination_approval_links" ("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "destination_approval_links_seq_idx" ON "bank"."destination_approval_links" ("destination_id", "seq");

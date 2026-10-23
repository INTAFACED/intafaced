-- Staff close and reopen of one account (J-ops-console-04 #7). A staff close records its reason code on the user row
-- (users.status stays the account state, 'closed'); a reopen clears it. Only 'customer_request', or a closure the
-- customer finalised through account_closures with no staff code, can be reopened. closed_from_frozen keeps a staff
-- freeze across a close: a reopen of an account closed while frozen returns it frozen, and lifting that freeze still
-- needs its own unfreeze approval. The closure history is kept in
-- founder_control_audit under its own kind, beside the freeze history.
-- Reversal: 0068_staff_account_closure.down.sql

ALTER TABLE "identity"."users"
  ADD COLUMN IF NOT EXISTS "closed_reason" text
  CHECK ("closed_reason" IS NULL OR "closed_reason" IN ('fraud', 'negative_balance', 'bank_reason', 'customer_request', 'other'));
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "closed_from_frozen" boolean NOT NULL DEFAULT false;

ALTER TABLE "identity"."founder_control_audit" DROP CONSTRAINT IF EXISTS "founder_control_audit_kind_check";
ALTER TABLE "identity"."founder_control_audit"
  ADD CONSTRAINT "founder_control_audit_kind_check" CHECK ("kind" IN ('identity', 'entitlement', 'bootstrap', 'closure'));

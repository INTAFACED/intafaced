-- svc-identity · support withdrawal freezes (J-support-public-20 #7, RC-support-public-06)
-- Reversal: 20261109024859_support_withdrawal_freezes.down.sql
--
-- One row per (support request, security lock): the record that a support agent froze a customer's withdrawals from a
-- request. The freeze itself is the account's security lock (account_security_locks, set_by = 'support'), written in
-- the same transaction. `lock_set` says whether this ask set the lock (false when the customer's own or an earlier
-- lock already held). The row holds no amount. It refuses update and delete.

CREATE TABLE IF NOT EXISTS "identity"."support_withdrawal_freezes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "lock_id" uuid NOT NULL REFERENCES "identity"."account_security_locks" ("id") ON DELETE CASCADE,
  "ticket_id" uuid NOT NULL,
  "operator_id" uuid NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "lock_set" boolean NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("ticket_id", "lock_id")
);
CREATE INDEX IF NOT EXISTS "support_withdrawal_freezes_user_idx" ON "identity"."support_withdrawal_freezes" ("user_id", "recorded_at" DESC);

CREATE OR REPLACE FUNCTION "identity"."support_withdrawal_freezes_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A cascade from deleting the user or the lock row is the account's erasure, not an edit of the record.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'identity.support_withdrawal_freezes is append-only';
END
$$;
DROP TRIGGER IF EXISTS "support_withdrawal_freezes_append_only" ON "identity"."support_withdrawal_freezes";
CREATE TRIGGER "support_withdrawal_freezes_append_only" BEFORE UPDATE OR DELETE ON "identity"."support_withdrawal_freezes"
  FOR EACH ROW EXECUTE FUNCTION "identity"."support_withdrawal_freezes_append_only"();

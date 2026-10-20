-- svc-identity · signed-out recovery flows and the mail outbox (I-signin-sessions-03).
-- Reversal: 0052_auth_flows_mail_outbox.down.sql.
--
-- One `auth_flows` row per request, whether or not the address belongs to an account, so a known and
-- an unknown address do the same database work. `subject_hash` is an HMAC of the address and is the
-- only identifier counted for caps; the address itself is never stored here. `code_hash` is the
-- SHA-256 of a mailed code (an unknown address gets the hash of a random value nobody holds).
-- `mail_outbox` holds the job the relay sends. `code` and `handle` live there only until the relay
-- claims the row; the relay clears them on claim, so a lost send never leaves a secret behind.
-- Password reset moves from password_reset_proofs to these tables; that table stays for old rows.
CREATE TABLE IF NOT EXISTS "identity"."auth_flows" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"         text NOT NULL CHECK ("kind" IN ('password_reset', 'handle_recovery')),
  "subject_hash" text NOT NULL CHECK ("subject_hash" ~ '^[0-9a-f]{64}$'),
  "user_id"      uuid REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "code_hash"    text CHECK ("code_hash" IS NULL OR "code_hash" ~ '^[0-9a-f]{64}$'),
  "status"       text NOT NULL CHECK ("status" IN ('code_sent', 'suppressed', 'locked', 'consumed')),
  "attempts"     integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "expires_at"   timestamptz NOT NULL,
  "consumed_at"  timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "auth_flows_subject_idx"
  ON "identity"."auth_flows" ("subject_hash", "kind", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "auth_flows_user_open_idx"
  ON "identity"."auth_flows" ("user_id")
  WHERE "consumed_at" IS NULL AND "user_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "identity"."mail_outbox" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "flow_id"    uuid NOT NULL REFERENCES "identity"."auth_flows"(id) ON DELETE CASCADE,
  "purpose"    text NOT NULL CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account'
  )),
  "recipient"  text NOT NULL,
  "code"       text,
  "handle"     text,
  "expires_at" timestamptz NOT NULL,
  "status"     text NOT NULL CHECK ("status" IN ('pending', 'sent', 'suppressed', 'undeliverable', 'unknown')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at"    timestamptz
);

CREATE INDEX IF NOT EXISTS "mail_outbox_pending_idx"
  ON "identity"."mail_outbox" ("created_at")
  WHERE "status" = 'pending';

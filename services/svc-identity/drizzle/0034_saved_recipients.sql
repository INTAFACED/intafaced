-- Saved pay recipients. The public name is the handle; label is the owner's
-- private nickname. No display name, email, or legal name is stored here.
-- Reversal: 0034_saved_recipients.down.sql

CREATE TABLE IF NOT EXISTS "identity"."saved_recipients" (
  "owner_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "recipient_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "label" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "recipient_id"),
  CONSTRAINT "saved_recipients_not_self_ck" CHECK ("owner_id" <> "recipient_id"),
  CONSTRAINT "saved_recipients_label_ck" CHECK (
    char_length("label") BETWEEN 1 AND 40 AND "label" !~ '[[:cntrl:]]'
  )
);

CREATE INDEX IF NOT EXISTS "saved_recipients_owner_idx"
  ON "identity"."saved_recipients" ("owner_id", "updated_at" DESC);

-- One row per write key so a retry returns the first result and a reused key
-- with different terms is a conflict rather than a second mutation.
CREATE TABLE IF NOT EXISTS "identity"."saved_recipient_commands" (
  "owner_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "idempotency_key" text NOT NULL,
  "action" text NOT NULL,
  "recipient_id" uuid NOT NULL,
  "label" text,
  "result" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "idempotency_key"),
  CONSTRAINT "saved_recipient_commands_key_ck" CHECK (length(btrim("idempotency_key")) BETWEEN 8 AND 64),
  CONSTRAINT "saved_recipient_commands_action_ck" CHECK ("action" IN ('add', 'remove')),
  CONSTRAINT "saved_recipient_commands_result_ck" CHECK ("result" IN ('saved', 'removed', 'absent')),
  CONSTRAINT "saved_recipient_commands_label_ck" CHECK (
    ("action" = 'add' AND "label" IS NOT NULL) OR ("action" = 'remove' AND "label" IS NULL)
  )
);

-- svc-notify · the launch desk's read-only Telegram alerts
-- Reversal: 20261127102114_notify_telegram_desk.down.sql
--
-- A person links one chat with a one-time code the account settings API issues; only the code's SHA-256 digest is kept,
-- with its expiry, and a newer code replaces the last. A link binds one chat to one person and one person to one chat.
-- The profit target is the week's realised profit at which the profit-lock alert fires. `telegram_marks` holds each
-- margin-use level's crossing number and whether it is armed, so a warning fires once per crossing. `telegram_alerts` is
-- the outbox: one row per alert business key (`fill:<fillId>`, `margin:<account>:<level>:<crossing>`,
-- `profit-lock:<weekStart>`), so an alert is raised once however many sweeps see it, and sent until a send succeeds.
-- No balance, no key and no venue credential is stored: the figures in an alert's text are the venue's, as read.

CREATE TABLE IF NOT EXISTS "notify"."telegram_link_codes" (
  "user_id" text PRIMARY KEY,
  "digest" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "telegram_link_codes_digest_ck" CHECK ("digest" ~ '^[0-9a-f]{64}$')
);
-- One code per person is the only key: a digest of 32 random bytes is looked up, not constrained.
CREATE INDEX IF NOT EXISTS "telegram_link_codes_digest_idx" ON "notify"."telegram_link_codes" ("digest");

CREATE TABLE IF NOT EXISTS "notify"."telegram_links" (
  "user_id" text PRIMARY KEY,
  "chat_id" text NOT NULL UNIQUE,
  "linked_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "notify"."telegram_targets" (
  "user_id" text PRIMARY KEY,
  "profit_target" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "telegram_targets_decimal_ck" CHECK ("profit_target" ~ '^[0-9]+(\.[0-9]+)?$')
);

CREATE TABLE IF NOT EXISTS "notify"."telegram_marks" (
  "user_id" text NOT NULL,
  "mark" text NOT NULL,
  "episode" integer NOT NULL DEFAULT 0,
  "armed" boolean NOT NULL DEFAULT true,
  PRIMARY KEY ("user_id", "mark")
);

CREATE TABLE IF NOT EXISTS "notify"."telegram_alerts" (
  "user_id" text NOT NULL,
  "alert_key" text NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "sent_at" timestamptz,
  PRIMARY KEY ("user_id", "alert_key")
);
CREATE INDEX IF NOT EXISTS "telegram_alerts_unsent_idx" ON "notify"."telegram_alerts" ("created_at") WHERE "sent_at" IS NULL;

-- svc-support · staff availability (SP-agents-01)
-- Reversal: 0015_staff_availability.down.sql
--
-- A staff member is online, busy or offline. Nobody starts online. The last
-- heartbeat is kept so an owner-set window can turn a silent agent offline;
-- with no window set, availability stays as last set. Every change is
-- appended to a log with who made it.

ALTER TABLE "support"."staff"
  ADD COLUMN IF NOT EXISTS "availability" text NOT NULL DEFAULT 'offline'
    CONSTRAINT "staff_availability_ck" CHECK ("availability" IN ('online', 'busy', 'offline')),
  ADD COLUMN IF NOT EXISTS "availability_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamptz;

CREATE TABLE IF NOT EXISTS "support"."staff_availability_log" (
  "id" bigserial PRIMARY KEY,
  "user_id" text NOT NULL,
  "availability" text NOT NULL CHECK ("availability" IN ('online', 'busy', 'offline')),
  "set_by" text NOT NULL,
  "reason" text CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500),
  "set_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "staff_availability_log_user_idx" ON "support"."staff_availability_log" ("user_id", "id");

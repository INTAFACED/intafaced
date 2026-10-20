-- svc-support · desk groups and ticket visibility (SP-desk-04)
-- Reversal: 0016_desk_groups.down.sql
--
-- A group is a named set of staff. A ticket may be placed in one group. Once
-- any group exists, an agent sees the tickets of their groups plus tickets
-- assigned to them. Every change to a group, a membership or a ticket's
-- group is appended to the log with who made it.

CREATE TABLE IF NOT EXISTS "support"."groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL UNIQUE CHECK (char_length("name") BETWEEN 1 AND 80),
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "support"."group_members" (
  "group_id" uuid NOT NULL REFERENCES "support"."groups" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "added_by" text NOT NULL,
  "added_at" timestamptz NOT NULL,
  PRIMARY KEY ("group_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "group_members_user_idx" ON "support"."group_members" ("user_id");

CREATE TABLE IF NOT EXISTS "support"."ticket_groups" (
  "ticket_id" uuid PRIMARY KEY REFERENCES "support"."tickets" ("id") ON DELETE CASCADE,
  "group_id" uuid NOT NULL REFERENCES "support"."groups" ("id") ON DELETE CASCADE,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "support"."group_log" (
  "id" bigserial PRIMARY KEY,
  "group_id" uuid NOT NULL,
  "action" text NOT NULL CHECK ("action" IN ('created', 'renamed', 'member_added', 'member_removed', 'ticket_grouped', 'ticket_ungrouped')),
  "subject" text,
  "by" text NOT NULL,
  "at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "group_log_group_idx" ON "support"."group_log" ("group_id", "id");

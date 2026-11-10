-- svc-support · automatic assignment, agent capacity and skills (SP-routing-01)
-- Reversal: 20261106090000_desk_routing.down.sql
--
-- A desk group may route its new requests automatically: off, in turn (round
-- robin) or to the least loaded agent. A group with no row has no routing set.
-- The cursor is the last agent a request went to, kept here so it survives a
-- restart. Capacity and skills are owner values per agent: a blank capacity
-- means the agent is never assigned automatically. A request may need a skill;
-- when no online agent with room has it, the request stays queued and its
-- routing state says no agent is available. Every change is logged with who.

CREATE TABLE IF NOT EXISTS "support"."group_routing" (
  "group_id" uuid PRIMARY KEY REFERENCES "support"."groups" ("id") ON DELETE CASCADE,
  "mode" text NOT NULL CHECK ("mode" IN ('off', 'round_robin', 'load_balanced')),
  "cursor_user_id" text,
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "support"."staff_routing" (
  "user_id" text PRIMARY KEY,
  "capacity" integer CHECK ("capacity" IS NULL OR "capacity" BETWEEN 0 AND 10000),
  "skills" text[] NOT NULL DEFAULT '{}',
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "support"."ticket_routing" (
  "ticket_id" uuid PRIMARY KEY REFERENCES "support"."tickets" ("id") ON DELETE CASCADE,
  "required_skill" text CHECK ("required_skill" IS NULL OR char_length("required_skill") BETWEEN 1 AND 40),
  "state" text CHECK ("state" IS NULL OR "state" IN ('assigned', 'no_agent')),
  "state_at" timestamptz,
  "set_by" text,
  "set_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "support"."routing_log" (
  "id" bigserial PRIMARY KEY,
  "action" text NOT NULL CHECK ("action" IN ('mode_set', 'capacity_set', 'skills_set', 'required_skill_set')),
  "subject" text NOT NULL,
  "value" text,
  "by" text NOT NULL,
  "at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "routing_log_subject_idx" ON "support"."routing_log" ("subject", "id");

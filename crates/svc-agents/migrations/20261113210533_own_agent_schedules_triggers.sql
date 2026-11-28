-- svc-agents · schedules and event triggers of a person's own agent (AG-sessions-02; J-agents-07 #1 to #4)
-- Reversal: 20261113210533_own_agent_schedules_triggers.down.sql
--
-- A schedule runs the agent once, or again every interval the person set (never below the owner's minimum). A trigger
-- runs it when one of the person's own events arrives (a subject declared in packages/events). Each occurrence or event
-- is one row of own_agent_auto_runs, unique on its business key (agents:schedule:<schedule>:<ordinal> or
-- agents:trigger:<trigger>:<event id>), written before anything runs: two workers waking for the same occurrence, or the
-- same event delivered twice, make one row and so one run. `wakes` counts the workers that woke for the occurrence; each
-- delivery of an event is a row of own_agent_trigger_deliveries, kept so a redelivery is seen, and the run row is the
-- seen-set, so a restart never runs an event twice. A run is metered like any run of the agent, through its usage window;
-- nothing here is a balance and no value moves here.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_schedules" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"         uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"         text NOT NULL,
  "create_key"       text NOT NULL,
  "repeat"           text NOT NULL,
  "interval_minutes" integer,
  "per_run_cap"      numeric(38, 18),
  "ask"              text NOT NULL,
  "state"            text NOT NULL DEFAULT 'active',
  "next_ordinal"     integer NOT NULL DEFAULT 1,
  "next_due_at"      timestamptz,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_schedules_repeat_ck" CHECK ("repeat" IN ('once', 'repeat')),
  CONSTRAINT "own_agent_schedules_interval_ck" CHECK (
    ("repeat" = 'once' AND "interval_minutes" IS NULL) OR ("repeat" = 'repeat' AND "interval_minutes" >= 1)
  ),
  CONSTRAINT "own_agent_schedules_cap_ck" CHECK ("per_run_cap" IS NULL OR "per_run_cap" >= 0),
  CONSTRAINT "own_agent_schedules_state_ck" CHECK ("state" IN ('active', 'completed', 'cancelled')),
  CONSTRAINT "own_agent_schedules_due_ck" CHECK (("state" = 'active') = ("next_due_at" IS NOT NULL)),
  CONSTRAINT "own_agent_schedules_key_uq" UNIQUE ("owner_id", "create_key")
);
CREATE INDEX IF NOT EXISTS "own_agent_schedules_agent_idx"
  ON "agents"."own_agent_schedules" ("owner_id", "agent_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "own_agent_schedules_due_idx"
  ON "agents"."own_agent_schedules" ("next_due_at") WHERE "state" = 'active';

CREATE TABLE IF NOT EXISTS "agents"."own_agent_triggers" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"    uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"    text NOT NULL,
  "create_key"  text NOT NULL,
  "subject"     text NOT NULL,
  "per_run_cap" numeric(38, 18),
  "ask"         text NOT NULL,
  "state"       text NOT NULL DEFAULT 'active',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_triggers_cap_ck" CHECK ("per_run_cap" IS NULL OR "per_run_cap" >= 0),
  CONSTRAINT "own_agent_triggers_state_ck" CHECK ("state" IN ('active', 'cancelled')),
  CONSTRAINT "own_agent_triggers_key_uq" UNIQUE ("owner_id", "create_key")
);
CREATE INDEX IF NOT EXISTS "own_agent_triggers_agent_idx"
  ON "agents"."own_agent_triggers" ("owner_id", "agent_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "own_agent_triggers_subject_idx"
  ON "agents"."own_agent_triggers" ("subject", "owner_id") WHERE "state" = 'active';

CREATE TABLE IF NOT EXISTS "agents"."own_agent_auto_runs" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_key"     text NOT NULL,
  "agent_id"    uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"    text NOT NULL,
  "source"      text NOT NULL,
  "source_id"   uuid NOT NULL,
  "ordinal"     integer,
  "event_id"    text,
  "due_at"      timestamptz NOT NULL,
  "state"       text NOT NULL DEFAULT 'claimed',
  "code"        text,
  "reason_code" text,
  "session_id"  uuid,
  "cost"        numeric(38, 18),
  "wakes"       integer NOT NULL DEFAULT 1,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_auto_runs_key_uq" UNIQUE ("run_key"),
  CONSTRAINT "own_agent_auto_runs_source_ck" CHECK (
    ("source" = 'schedule' AND "ordinal" >= 1 AND "event_id" IS NULL) OR ("source" = 'trigger' AND "ordinal" IS NULL AND "event_id" IS NOT NULL)
  ),
  CONSTRAINT "own_agent_auto_runs_state_ck" CHECK ("state" IN ('claimed', 'ran', 'skipped', 'refused', 'failed')),
  CONSTRAINT "own_agent_auto_runs_cost_ck" CHECK ("cost" IS NULL OR "cost" >= 0),
  CONSTRAINT "own_agent_auto_runs_wakes_ck" CHECK ("wakes" >= 1)
);
CREATE INDEX IF NOT EXISTS "own_agent_auto_runs_source_idx"
  ON "agents"."own_agent_auto_runs" ("source_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "own_agent_auto_runs_claimed_idx"
  ON "agents"."own_agent_auto_runs" ("updated_at") WHERE "state" = 'claimed';

CREATE TABLE IF NOT EXISTS "agents"."own_agent_trigger_deliveries" (
  "trigger_id"  uuid NOT NULL REFERENCES "agents"."own_agent_triggers" ("id"),
  "agent_id"    uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "envelope_id" text NOT NULL,
  "event_id"    text NOT NULL,
  "redelivered" boolean NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("trigger_id", "envelope_id")
);
CREATE INDEX IF NOT EXISTS "own_agent_trigger_deliveries_trigger_idx"
  ON "agents"."own_agent_trigger_deliveries" ("trigger_id", "received_at" DESC);

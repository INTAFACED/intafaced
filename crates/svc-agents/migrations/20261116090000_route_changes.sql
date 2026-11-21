-- svc-agents · founders' changes to the model routing table (J-agents-20; AG-usage-02, RC-agents-05)
-- Reversal: 20261116090000_route_changes.down.sql
--
-- The routing table is configuration (AGENTS_ROUTING_TABLE): each task's provider and model alias come from there and
-- nowhere else, so a provider swap is a configuration change and no code change. On top of it, founders may change a
-- route's output ceiling and its rates, and only two distinct founders together:
--   · `route_change_requests`: one founder's proposed change, waiting for a second founder. It is applied once, or the
--     proposer withdraws it; a confirmed or withdrawn request never changes again.
--   · `route_overrides`: the change two founders confirmed, one row per task, read over the configured table at boot
--     and after each change. A rate change takes effect at `price_from`, the start of the next usage window, and until
--     then the window's calls keep `prior_*`, the rate in force when it was confirmed.
--   · `route_change_audit`: one row per proposal, withdrawal and confirmation, on a business key, naming the proposer
--     and the confirming founder, with the route before and after.
-- Nothing here is a balance and no value moves: a rate prices future calls; what a call cost is fixed on its usage row.

CREATE TABLE IF NOT EXISTS "agents"."route_change_requests" (
  "id"                 uuid PRIMARY KEY,
  "request_id"         text NOT NULL,
  "task"               text NOT NULL,
  "max_output_tokens"  integer NOT NULL,
  "input_per_million"  numeric(38, 18),
  "output_per_million" numeric(38, 18),
  "status"             text NOT NULL DEFAULT 'pending',
  "proposed_by"        text NOT NULL,
  "confirmed_by"       text,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "decided_at"         timestamptz,
  CONSTRAINT "route_change_requests_request_key" UNIQUE ("request_id"),
  CONSTRAINT "route_change_requests_status_check" CHECK ("status" IN ('pending', 'applied', 'withdrawn')),
  CONSTRAINT "route_change_requests_ceiling_check" CHECK ("max_output_tokens" BETWEEN 1 AND 1000000),
  CONSTRAINT "route_change_requests_rates_check"
    CHECK (("input_per_million" IS NULL) = ("output_per_million" IS NULL) AND coalesce("input_per_million", 0) >= 0 AND coalesce("output_per_million", 0) >= 0),
  CONSTRAINT "route_change_requests_two_founders_check" CHECK ("confirmed_by" IS NULL OR "confirmed_by" <> "proposed_by"),
  CONSTRAINT "route_change_requests_decided_check" CHECK (("status" = 'pending') = ("decided_at" IS NULL)),
  CONSTRAINT "route_change_requests_applied_check" CHECK (("status" = 'applied') = ("confirmed_by" IS NOT NULL))
);

-- At most one change waits on a task at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "route_change_requests_one_pending_idx"
  ON "agents"."route_change_requests" ("task") WHERE "status" = 'pending';

CREATE TABLE IF NOT EXISTS "agents"."route_overrides" (
  "task"                     text PRIMARY KEY,
  "max_output_tokens"        integer NOT NULL,
  "input_per_million"        numeric(38, 18),
  "output_per_million"       numeric(38, 18),
  "prior_input_per_million"  numeric(38, 18),
  "prior_output_per_million" numeric(38, 18),
  "price_from"               timestamptz NOT NULL,
  "change_id"                uuid NOT NULL REFERENCES "agents"."route_change_requests"("id"),
  "updated_at"               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "route_overrides_ceiling_check" CHECK ("max_output_tokens" BETWEEN 1 AND 1000000),
  CONSTRAINT "route_overrides_rates_check" CHECK (("input_per_million" IS NULL) = ("output_per_million" IS NULL)),
  CONSTRAINT "route_overrides_prior_rates_check" CHECK (("prior_input_per_million" IS NULL) = ("prior_output_per_million" IS NULL))
);

CREATE TABLE IF NOT EXISTS "agents"."route_change_audit" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_key" text NOT NULL,
  "change_id"    uuid NOT NULL REFERENCES "agents"."route_change_requests"("id"),
  "task"         text NOT NULL,
  "action"       text NOT NULL,
  "operator_id"  text NOT NULL,
  "proposed_by"  text NOT NULL,
  "before"       jsonb NOT NULL,
  "after"        jsonb NOT NULL,
  "at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "route_change_audit_key" UNIQUE ("business_key"),
  CONSTRAINT "route_change_audit_action_check" CHECK ("action" IN ('propose', 'withdraw', 'confirm'))
);

CREATE INDEX IF NOT EXISTS "route_change_audit_at_idx" ON "agents"."route_change_audit" ("at" DESC, "id" DESC);

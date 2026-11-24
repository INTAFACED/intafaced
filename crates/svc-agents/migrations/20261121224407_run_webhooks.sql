-- svc-agents · webhooks for the runs a person started in their own session (AG-sessions-04; J-agents-12 #5)
-- Reversal: 20261121224407_run_webhooks.down.sql
--
-- `run_webhook_endpoints`: an endpoint a person registered with their own API key, once per `id`; its signing secret is
-- shown on the register that made it and never again. `run_webhook_deliveries`: one row per (finished run, endpoint),
-- written in the same transaction that ends the run, so a run that ends is delivered once to each endpoint the person
-- had then, and a run that ends again (a refused run run again) is a new event. `payload` is what is posted: ids,
-- state, the reply, cost and refusal codes, never the person's prompt. Nothing here is a balance and no value moves.

CREATE TABLE IF NOT EXISTS "agents"."run_webhook_endpoints" (
  "id"           uuid PRIMARY KEY,
  "user_id"      text NOT NULL,
  "url"          text NOT NULL,
  "secret"       text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "disabled_at"  timestamptz
);
CREATE INDEX IF NOT EXISTS "run_webhook_endpoints_user_idx" ON "agents"."run_webhook_endpoints" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "agents"."run_webhook_deliveries" (
  "event_id"         text NOT NULL,
  "endpoint_id"      uuid NOT NULL REFERENCES "agents"."run_webhook_endpoints" ("id"),
  "user_id"          text NOT NULL,
  "run_id"           uuid NOT NULL,
  "payload"          jsonb NOT NULL,
  "state"            text NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending', 'delivered', 'failed')),
  "attempts"         integer NOT NULL DEFAULT 0,
  "last_status"      integer,
  "last_error"       text,
  "next_attempt_at"  timestamptz NOT NULL DEFAULT now(),
  "lease_until"      timestamptz,
  "delivered_at"     timestamptz,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("event_id", "endpoint_id")
);
CREATE INDEX IF NOT EXISTS "run_webhook_deliveries_due_idx" ON "agents"."run_webhook_deliveries" ("next_attempt_at") WHERE "state" = 'pending';
CREATE INDEX IF NOT EXISTS "run_webhook_deliveries_user_idx" ON "agents"."run_webhook_deliveries" ("user_id", "created_at" DESC);

-- svc-agents · test sets and evaluation runs for a person's own agent (AG-testing-02; J-agents-04 #5 to #7)
-- Reversal: 20261104153508_own_agent_evaluations.down.sql
--
-- The test set is the agent's cases, in the order the person wrote them; a run that starts saves its cases as the set.
-- A run is every case on every repeat through the test engine (no model, never billed, no ledger call), each result
-- labelled TEST, keyed agents:eval:<agent>:<request id> so the same request again is the same run. The score is the
-- passed share in percent, cut to two places; the verdict compares the exact share with the threshold. Nothing here is
-- a balance and no value moves.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_eval_cases" (
  "agent_id"   uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"   text NOT NULL,
  "position"   integer NOT NULL,
  "input"      text NOT NULL,
  "expected"   text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "agent_id", "position"),
  CONSTRAINT "own_agent_eval_cases_position_ck" CHECK ("position" >= 0)
);

CREATE TABLE IF NOT EXISTS "agents"."own_agent_eval_runs" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"     uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"     text NOT NULL,
  "request_id"   text NOT NULL,
  "request_key"  text NOT NULL,
  "cases_json"   jsonb NOT NULL,
  "repeats"      integer NOT NULL,
  "threshold"    text NOT NULL,
  "passed"       integer NOT NULL,
  "total"        integer NOT NULL,
  "score"        text NOT NULL,
  "verdict"      text NOT NULL,
  "results_json" jsonb NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_eval_runs_counts_ck" CHECK ("repeats" >= 1 AND "total" >= 1 AND "passed" >= 0 AND "passed" <= "total"),
  CONSTRAINT "own_agent_eval_runs_verdict_ck" CHECK ("verdict" IN ('pass', 'fail')),
  CONSTRAINT "own_agent_eval_runs_key_uq" UNIQUE ("owner_id", "request_key")
);
CREATE INDEX IF NOT EXISTS "own_agent_eval_runs_agent_idx"
  ON "agents"."own_agent_eval_runs" ("owner_id", "agent_id", "created_at" DESC);

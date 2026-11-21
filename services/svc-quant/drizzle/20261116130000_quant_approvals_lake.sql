-- svc-quant · live approval policy and the market data lake (J-algo-dev-16 #2 #4; RC-algo-dev-01, RC-algo-dev-02)
-- Reversal: the matching .down.sql
--
-- No money, no balance, no ledger post.
--
-- approval_policies: one row per account, the account owner's own choice whether a strategy of theirs may go live only
-- after a different member approved that exact version. No row is "not set".
-- strategy_approvals: one row per approval request of one strategy version, bound to the content hash of that version's
-- rules and the strategy's risk settings as they stood; its decision is set once, by a reviewer who is not the requester.
-- lake_rows: the exchange's own public market data as captured (ticks, order book snapshots and anonymised taker fills),
-- normalised; never any account's own orders or fills.
-- lake_passes: one row per capture pass of one symbol and kind, ok or a hole with its reason, so coverage and gaps are
-- read from what was captured, not inferred.
-- lake_capture_changes: insert-only audit of an operator pausing or resuming capture of one symbol, with a reason.

CREATE TABLE IF NOT EXISTS "quant"."approval_policies" (
  "account_id" uuid PRIMARY KEY,
  "required" boolean NOT NULL,
  "write_key" text NOT NULL CHECK (char_length("write_key") BETWEEN 1 AND 256),
  "actor" uuid NOT NULL,
  "set_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "quant"."strategy_approvals" (
  "id" uuid PRIMARY KEY,
  "request_key" text NOT NULL UNIQUE CHECK (char_length("request_key") BETWEEN 1 AND 256),
  "account_id" uuid NOT NULL,
  "strategy_id" text NOT NULL REFERENCES "quant"."strategies"("id"),
  "strategy_version" integer NOT NULL CHECK ("strategy_version" > 0),
  "content_hash" text NOT NULL CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  "requester" uuid NOT NULL,
  "reviewer" uuid,
  "decision" text NOT NULL CHECK ("decision" IN ('pending', 'approved', 'rejected')),
  "reason" text NOT NULL DEFAULT '' CHECK (char_length("reason") <= 500),
  "requested_at" timestamptz NOT NULL,
  "decided_at" timestamptz,
  CHECK ("reviewer" IS NULL OR "reviewer" <> "requester"),
  CHECK (("decision" = 'pending') = ("decided_at" IS NULL))
);

CREATE INDEX IF NOT EXISTS "strategy_approvals_strategy_idx" ON "quant"."strategy_approvals" ("strategy_id", "requested_at" DESC);

CREATE TABLE IF NOT EXISTS "quant"."lake_rows" (
  "source_key" text PRIMARY KEY CHECK (char_length("source_key") BETWEEN 1 AND 256),
  "kind" text NOT NULL CHECK ("kind" IN ('tick', 'book', 'fill')),
  "symbol" text NOT NULL CHECK (char_length("symbol") BETWEEN 1 AND 32),
  "observed_at" timestamptz NOT NULL,
  "payload" jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS "lake_rows_kind_symbol_idx" ON "quant"."lake_rows" ("kind", "symbol", "observed_at" DESC);

CREATE TABLE IF NOT EXISTS "quant"."lake_passes" (
  "symbol" text NOT NULL CHECK (char_length("symbol") BETWEEN 1 AND 32),
  "kind" text NOT NULL CHECK ("kind" IN ('tick', 'book', 'fill')),
  "at" timestamptz NOT NULL,
  "ok" boolean NOT NULL,
  "reason" text CHECK ("reason" IS NULL OR char_length("reason") <= 200),
  PRIMARY KEY ("symbol", "kind", "at")
);

CREATE TABLE IF NOT EXISTS "quant"."lake_capture_changes" (
  "id" uuid PRIMARY KEY,
  "symbol" text NOT NULL CHECK (char_length("symbol") BETWEEN 1 AND 32),
  "capturing" boolean NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "actor" text NOT NULL,
  "write_key" text NOT NULL UNIQUE CHECK (char_length("write_key") BETWEEN 1 AND 256),
  "at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "lake_capture_changes_symbol_idx" ON "quant"."lake_capture_changes" ("symbol", "at" DESC);

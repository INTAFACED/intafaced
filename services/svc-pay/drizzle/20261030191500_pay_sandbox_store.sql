-- DV-sandbox-02 (J-developer-02 #5, #8): the developer sandbox store.
-- Reversal: 20261030191500_pay_sandbox_store.down.sql
--
-- TEST balances for a person's developer sandboxes, in their own `sandbox_` tables. svc-pay's database role owns only
-- the `pay` schema (tooling/infra/postgres-init/01-service-schemas.sql: one schema and one role per service), so the
-- store is kept apart by its tables and its code rather than a second schema. They are not money: nothing here is posted
-- to the ledger, read from it or moved to real funds, and the code that writes this schema imports no ledger-client
-- (developer-sandbox-funds/isolation.test.ts). Every figure is shown labelled TEST. The lead's ruling of 2026-10-30
-- (ENGINE section 10, "Decisions for the thread": a separate sandbox store with no ledger grant).
--
-- A balance is keyed by the person and the sandbox id, so one account's presses never reach another account's rows.
-- Each fund or reset is one event row under its business request id; `version` counts them, and the next request id
-- the page sends carries the version it read.

CREATE TABLE IF NOT EXISTS "pay"."sandbox_balances" (
  "user_id" uuid NOT NULL,
  "sandbox_id" uuid NOT NULL,
  "asset" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "sandbox_id", "asset"),
  CONSTRAINT "sandbox_balances_amount_not_negative" CHECK ("amount" >= 0)
);

CREATE TABLE IF NOT EXISTS "pay"."sandbox_events" (
  "id" bigserial PRIMARY KEY,
  "request_id" text NOT NULL UNIQUE,
  "user_id" uuid NOT NULL,
  "sandbox_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "asset" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sandbox_events_kind_known" CHECK ("kind" IN ('fund', 'reset')),
  CONSTRAINT "sandbox_events_amount_not_negative" CHECK ("amount" >= 0)
);

CREATE INDEX IF NOT EXISTS "sandbox_events_sandbox_day" ON "pay"."sandbox_events" ("user_id", "sandbox_id", "kind", "created_at");

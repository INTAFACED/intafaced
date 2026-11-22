-- Limit-increase requests for personal transfers (BK-acct-04, accounts-insights-027).
--
-- A customer asks for a higher per-transfer or daily limit on one asset; compliance approves with a granted amount or
-- declines. The id is the customer's own request id (business key). At most one open request per customer, asset and
-- kind. The latest approved grant replaces the published limit of that kind for that customer only; with no published
-- terms for the asset nothing changes (terms stay the gate). No balance is held here.
--
-- Reversal: 0048_limit_increase_requests.down.sql

CREATE TABLE IF NOT EXISTS "bank"."limit_increase_requests" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL,
  "asset_id" text NOT NULL,
  "kind" text NOT NULL,
  "requested" numeric(38, 18) NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "granted" numeric(38, 18),
  "decided_by" text,
  "decision_note" text,
  "decided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "limit_increase_requests_kind_ck" CHECK ("kind" IN ('per_transfer', 'daily')),
  CONSTRAINT "limit_increase_requests_status_ck" CHECK ("status" IN ('open', 'approved', 'declined')),
  CONSTRAINT "limit_increase_requests_requested_ck" CHECK ("requested" > 0),
  CONSTRAINT "limit_increase_requests_granted_ck" CHECK (("status" = 'approved') = ("granted" IS NOT NULL) AND ("granted" IS NULL OR "granted" > 0)),
  CONSTRAINT "limit_increase_requests_decided_ck" CHECK (("status" = 'open') = ("decided_by" IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "limit_increase_requests_open_uq"
  ON "bank"."limit_increase_requests" ("user_id", "asset_id", "kind") WHERE "status" = 'open';
CREATE INDEX IF NOT EXISTS "limit_increase_requests_granted_idx"
  ON "bank"."limit_increase_requests" ("user_id", "asset_id", "kind", "decided_at" DESC) WHERE "status" = 'approved';

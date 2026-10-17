-- svc-pay · W2 metrics read model: projection tables and the dirty log.
-- Reversal: 0055_pay_metrics_projection.down.sql
--
-- NOT MONEY OF RECORD. Every figure in these tables is a pure function of
-- pay.payments, pay.payment_events, pay.settlements and pay.checkout_sessions
-- and is recomputed from them (src/metrics/compute.ts). A row here can always be
-- thrown away and rebuilt; the ledger and the append-only event log stay the
-- truth. Balances are deliberately NOT here: they are read live from the ledger.
--
-- Amounts are numeric(38,18) like every other svc-pay column and are handled as
-- scaled bigint (10^18) in TypeScript, never as `number`. Days are UTC dates.

-- Insert-only log of "this merchant-day needs recomputing", written by triggers
-- (0056) inside the SAME transaction as the source write. It is insert-only on
-- purpose: an upsert would put every concurrent writer of one merchant-day on a
-- single row lock for the rest of its transaction. Rows are removed only by the
-- refresher, by exact id, after it has recomputed the key.
CREATE TABLE IF NOT EXISTS "pay"."metrics_dirty" (
  "id"          bigserial PRIMARY KEY,
  "merchant_id" uuid NOT NULL,
  "day"         date NOT NULL,
  "marked_at"   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "metrics_dirty_key_idx" ON "pay"."metrics_dirty" ("merchant_id", "day");
CREATE INDEX IF NOT EXISTS "metrics_dirty_marked_idx" ON "pay"."metrics_dirty" ("marked_at");

-- Per merchant, UTC day, asset. Each column says which source day it is bucketed on:
--   payments_created, unsettled_net      -> the payment's created_at day
--   captured, captured_count, largest    -> the captured event's own day
--   refunded, refunded_count             -> the day the payment was CAPTURED (cohort).
--     Contract amounts are unsigned, so a refund must never push `net` below zero
--     inside a window; attributing a refund to its payment's capture day keeps
--     net = captured - refunded >= 0 for any window.
--   settle_*                             -> the settlement's created_at day, status posted|paid_out
CREATE TABLE IF NOT EXISTS "pay"."metrics_merchant_day" (
  "merchant_id"      uuid NOT NULL REFERENCES "pay"."merchants" ("id"),
  "day"              date NOT NULL,
  "asset_code"       text NOT NULL,
  "payments_created" integer NOT NULL DEFAULT 0 CHECK ("payments_created" >= 0),
  "captured"         numeric(38,18) NOT NULL DEFAULT 0 CHECK ("captured" >= 0),
  "captured_count"   integer NOT NULL DEFAULT 0 CHECK ("captured_count" >= 0),
  "largest_captured" numeric(38,18) NOT NULL DEFAULT 0 CHECK ("largest_captured" >= 0),
  "refunded"         numeric(38,18) NOT NULL DEFAULT 0 CHECK ("refunded" >= 0),
  "refunded_count"   integer NOT NULL DEFAULT 0 CHECK ("refunded_count" >= 0),
  "settle_gross"     numeric(38,18) NOT NULL DEFAULT 0 CHECK ("settle_gross" >= 0),
  "settle_fees"      numeric(38,18) NOT NULL DEFAULT 0 CHECK ("settle_fees" >= 0),
  "settle_net"       numeric(38,18) NOT NULL DEFAULT 0 CHECK ("settle_net" >= 0),
  "settle_count"     integer NOT NULL DEFAULT 0 CHECK ("settle_count" >= 0),
  "unsettled_net"    numeric(38,18) NOT NULL DEFAULT 0 CHECK ("unsettled_net" >= 0),
  PRIMARY KEY ("merchant_id", "day", "asset_code")
);
CREATE INDEX IF NOT EXISTS "metrics_merchant_day_day_idx" ON "pay"."metrics_merchant_day" ("day", "merchant_id");

-- Payments created that day, by their CURRENT status (the status mix).
CREATE TABLE IF NOT EXISTS "pay"."metrics_merchant_day_status" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants" ("id"),
  "day"         date NOT NULL,
  "status"      "pay"."payment_status" NOT NULL,
  "payments"    integer NOT NULL CHECK ("payments" > 0),
  PRIMARY KEY ("merchant_id", "day", "status")
);

-- Captured payments created that day that came in through a payment link's
-- checkout session. One row per link so "links used" over a window is an exact
-- COUNT(DISTINCT link_id), not a sum of daily distinct counts.
CREATE TABLE IF NOT EXISTS "pay"."metrics_merchant_day_link" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants" ("id"),
  "day"         date NOT NULL,
  "link_id"     uuid NOT NULL,
  "payments"    integer NOT NULL CHECK ("payments" > 0),
  PRIMARY KEY ("merchant_id", "day", "link_id")
);

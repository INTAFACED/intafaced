-- Per-asset pause of new borrow and new supply (BK-loan-07).
--
-- A product-level pause owned by svc-bank. It is not the platform posting freeze (svc-ledger `posting_freeze`) and not
-- one account's freeze (svc-identity). No row for an asset means it has never been paused. Every change bumps the
-- revision by one; the history row for (asset, revision) is the business key `ops-pause:<asset>:<revision>`, so two
-- operators racing on the same revision produce one change and one `bank.ops_revision_conflict`.
--
-- Reversal: 0050_asset_pauses.down.sql

CREATE TABLE IF NOT EXISTS "bank"."asset_pauses" (
  "asset_id" text PRIMARY KEY,
  "borrow_paused" boolean NOT NULL,
  "supply_paused" boolean NOT NULL,
  "revision" integer NOT NULL,
  "reason" text NOT NULL,
  "approved_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "asset_pauses_revision_ck" CHECK ("revision" >= 1)
);

CREATE TABLE IF NOT EXISTS "bank"."asset_pause_history" (
  "asset_id" text NOT NULL,
  "revision" integer NOT NULL,
  "change_key" text NOT NULL,
  "borrow_paused" boolean NOT NULL,
  "supply_paused" boolean NOT NULL,
  "reason" text NOT NULL,
  "approved_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("asset_id", "revision"),
  CONSTRAINT "asset_pause_history_change_key_uq" UNIQUE ("change_key"),
  CONSTRAINT "asset_pause_history_revision_ck" CHECK ("revision" >= 1)
);

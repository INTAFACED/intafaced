-- The operator's partner stop (project-state #1790; the money model's change 4 item 3).
--
-- A stop owned by svc-bank, narrower than svc-ledger's platform posting freeze: the kinds of partner instruction listed
-- here are refused before the partner is asked, while posting stays enabled. No row for a partner means it has never
-- been stopped. Every change bumps the revision by one; the history row for (partner, revision) is the business key
-- `ops-partner-stop:<partner>:<revision>`, so two operators racing on the same revision produce one change and one
-- `bank.ops_revision_conflict`.
--
-- Reversal: 20261110100111_partner_stops.down.sql

CREATE TABLE IF NOT EXISTS "bank"."partner_stops" (
  "partner_id" text PRIMARY KEY,
  "stopped_kinds" text[] NOT NULL,
  "revision" integer NOT NULL,
  "reason" text NOT NULL,
  "approved_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_stops_revision_ck" CHECK ("revision" >= 1),
  CONSTRAINT "partner_stops_kinds_ck" CHECK ("stopped_kinds" <@ ARRAY['bank_move','card_hold','card_capture','card_release','card_refund']::text[])
);

CREATE TABLE IF NOT EXISTS "bank"."partner_stop_history" (
  "partner_id" text NOT NULL,
  "revision" integer NOT NULL,
  "change_key" text NOT NULL,
  "stopped_kinds" text[] NOT NULL,
  "reason" text NOT NULL,
  "approved_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("partner_id", "revision"),
  CONSTRAINT "partner_stop_history_change_key_uq" UNIQUE ("change_key"),
  CONSTRAINT "partner_stop_history_revision_ck" CHECK ("revision" >= 1)
);

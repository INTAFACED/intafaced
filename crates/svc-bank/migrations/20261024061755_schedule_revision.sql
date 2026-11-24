-- Standing order edits and one-offs (BK-xfer-10, J-bank-06 #1-#2).
--
-- `revision` starts at 1 and an edit adds one. An edit names the revision it read and the UPDATE is guarded by it, so of
-- two edits sent at the same revision exactly one lands.
ALTER TABLE "bank"."scheduled_transfers" ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1;
ALTER TABLE "bank"."scheduled_transfers" DROP CONSTRAINT IF EXISTS "scheduled_transfers_revision_ck";
ALTER TABLE "bank"."scheduled_transfers" ADD CONSTRAINT "scheduled_transfers_revision_ck" CHECK ("revision" >= 1);

-- A one-off has one date. An end date on it would be a second instruction nothing reads.
ALTER TABLE "bank"."scheduled_transfers" DROP CONSTRAINT IF EXISTS "scheduled_transfers_once_no_end_ck";
ALTER TABLE "bank"."scheduled_transfers" ADD CONSTRAINT "scheduled_transfers_once_no_end_ck"
  CHECK ("cadence" <> 'once' OR "ends_at" IS NULL);

-- Auto-invest shares the cadence type and has no one-off: a DCA rule is recurring by definition.
ALTER TABLE "bank"."auto_invest_rules" DROP CONSTRAINT IF EXISTS "auto_invest_rules_not_once_ck";
ALTER TABLE "bank"."auto_invest_rules" ADD CONSTRAINT "auto_invest_rules_not_once_ck"
  CHECK ("cadence" IS NULL OR "cadence" <> 'once');

-- What a standing order said before each edit, so what the person authorised survives the edit. One row per replaced
-- revision; the current terms are the order's own row.
CREATE TABLE IF NOT EXISTS "bank"."schedule_revisions" (
  "schedule_id" uuid NOT NULL REFERENCES "bank"."scheduled_transfers"("id"),
  "revision"    integer NOT NULL,
  "amount"      numeric(38, 18) NOT NULL,
  "ends_at"     timestamptz,
  "replaced_by" text NOT NULL,
  "replaced_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("schedule_id", "revision"),
  CONSTRAINT "schedule_revisions_amount_positive_ck" CHECK ("amount" > 0)
);

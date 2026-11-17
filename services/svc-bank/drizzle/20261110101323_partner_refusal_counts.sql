-- What the posting freeze and the operator's partner stop refused, counted (project-state #1790; the money model's
-- change 4 item 4). One row per UTC day, refuser, cause and kind of partner instruction. A count, never money.
--
-- Reversal: 20261110101323_partner_refusal_counts.down.sql

CREATE TABLE IF NOT EXISTS "bank"."partner_refusal_counts" (
  "day" date NOT NULL,
  "refused_by" text NOT NULL,
  "cause" text NOT NULL,
  "kind" text NOT NULL,
  "count" bigint NOT NULL,
  PRIMARY KEY ("day", "refused_by", "cause", "kind"),
  CONSTRAINT "partner_refusal_counts_refused_by_ck" CHECK ("refused_by" IN ('posting_freeze', 'partner_stop')),
  CONSTRAINT "partner_refusal_counts_count_ck" CHECK ("count" >= 1)
);

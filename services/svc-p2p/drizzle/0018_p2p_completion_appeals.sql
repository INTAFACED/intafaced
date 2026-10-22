-- P-trade-orders-21: one-time completion-rate appeal per user.
-- An accepted appeal excludes its trade from that user's completion
-- denominator. The decision columns are the audit row. No balance here.
-- Reversal: 0018_p2p_completion_appeals.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."completion_appeals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "trade_id" uuid NOT NULL REFERENCES "p2p"."p2p_trades" ("id"),
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'submitted',
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "review_due_at" timestamptz NOT NULL,
  "decided_by" text,
  "decided_at" timestamptz,
  "decision_reason" text,
  CONSTRAINT "completion_appeals_one_per_user" UNIQUE ("user_id"),
  CONSTRAINT "completion_appeals_status_ck" CHECK ("status" IN ('submitted', 'accepted', 'rejected')),
  CONSTRAINT "completion_appeals_reason_ck" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "completion_appeals_decided_ck" CHECK (
    ("status" = 'submitted' AND "decided_by" IS NULL AND "decided_at" IS NULL)
    OR ("status" <> 'submitted' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND length(btrim(coalesce("decision_reason", ''))) > 0)
  )
);

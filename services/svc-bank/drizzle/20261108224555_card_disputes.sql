-- J-bank-27 (BK-cdisp-02, BK-cdisp-03): card disputes worked by support. A case is a RECORD of one cardholder's dispute of
-- one settled card capture, its evidence and representment, the card partner's provisional credit and the decision. The
-- money is the partner's (OWNER 226): a provisional credit is the partner's credit to its own cardholder, under its
-- licence, recorded here with the partner's reference and the amount the partner reports. Nothing posts to the ledger for
-- a dispute and nothing here is summed into a balance.
CREATE TABLE IF NOT EXISTS "bank"."card_disputes" (
  "id" uuid PRIMARY KEY,
  -- The business key the case was opened under; the same key with other figures refuses.
  "case_key" text NOT NULL UNIQUE,
  "card_id" uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "user_id" uuid NOT NULL,
  -- One case per authorisation: a second dispute of the same payment is the same case.
  "authorization_id" uuid NOT NULL UNIQUE REFERENCES "bank"."card_authorizations" ("id"),
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL CHECK ("amount" > 0),
  "reason" text NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('opened', 'representment', 'arbitration', 'closed')),
  -- True when the card programme is the simulator: every surface that shows the case says TEST.
  "test" boolean NOT NULL,
  -- The partner's provisional credit: asked (before the partner is called, so a crash leaves the ask), then answered with
  -- the amount the partner reports and its reference.
  "credit_requested_at" timestamptz,
  "credit_amount" numeric(38, 18) CHECK ("credit_amount" IS NULL OR "credit_amount" > 0),
  "credit_partner_ref" text,
  "credited_at" timestamptz,
  -- The decision: for whom, who bears the fraud loss under the partner's terms or "not known", and what the partner did
  -- with its provisional credit.
  "outcome" text CHECK ("outcome" IN ('cardholder', 'merchant')),
  "loss_status" text CHECK ("loss_status" IN ('reported', 'not_known')),
  "loss_bearer" text CHECK ("loss_bearer" IN ('partner', 'programme', 'cardholder')),
  "loss_terms" text,
  "credit_settlement" text CHECK ("credit_settlement" IN ('final', 'reversed')),
  "credit_settlement_partner_ref" text,
  "closed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "card_disputes_credit_answered" CHECK (
    ("credit_partner_ref" IS NULL) = ("credit_amount" IS NULL) AND ("credit_partner_ref" IS NULL) = ("credited_at" IS NULL)
    AND ("credit_partner_ref" IS NULL OR "credit_requested_at" IS NOT NULL)
  ),
  -- "not known" carries no bearer; a reported bearer carries the partner's terms. A loss is never written without one.
  CONSTRAINT "card_disputes_loss_shape" CHECK (
    ("loss_status" IS NULL AND "loss_bearer" IS NULL AND "loss_terms" IS NULL)
    OR ("loss_status" = 'not_known' AND "loss_bearer" IS NULL AND "loss_terms" IS NULL)
    OR ("loss_status" = 'reported' AND "loss_bearer" IS NOT NULL AND "loss_terms" IS NOT NULL)
  ),
  CONSTRAINT "card_disputes_closed_decided" CHECK (
    ("state" = 'closed') = ("closed_at" IS NOT NULL)
    AND ("state" <> 'closed' OR ("outcome" IS NOT NULL AND "loss_status" IS NOT NULL))
    AND (("credit_settlement" IS NULL) OR ("credit_partner_ref" IS NOT NULL AND "state" = 'closed'))
  )
);
CREATE INDEX IF NOT EXISTS "card_disputes_state_idx" ON "bank"."card_disputes" ("state", "created_at");

-- Every transition and every piece of evidence, with who did it and when. Append-only.
CREATE TABLE IF NOT EXISTS "bank"."card_dispute_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dispute_id" uuid NOT NULL REFERENCES "bank"."card_disputes" ("id"),
  "sequence" integer NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('opened', 'evidence', 'representment', 'arbitration', 'provisional_credit', 'closed')),
  "from_state" text,
  "to_state" text NOT NULL,
  "actor" text NOT NULL,
  "detail" text,
  -- Evidence added after the representment was submitted: kept, with its own time, and marked so.
  "after_submission" boolean NOT NULL DEFAULT false,
  -- The business key of the step, so a retried step is the same step.
  "event_key" text NOT NULL UNIQUE,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "card_dispute_events_seq" UNIQUE ("dispute_id", "sequence")
);

CREATE OR REPLACE FUNCTION "bank"."card_dispute_events_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bank.card_dispute_events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "card_dispute_events_append_only" ON "bank"."card_dispute_events";
CREATE TRIGGER "card_dispute_events_append_only" BEFORE UPDATE OR DELETE ON "bank"."card_dispute_events"
  FOR EACH ROW EXECUTE FUNCTION "bank"."card_dispute_events_append_only"();

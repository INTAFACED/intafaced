-- THE NAME A PAYER GAVE FOR A BANK TRANSFER, AND THE PAYMENTS HELD BECAUSE A TRANSFER'S NAME DID NOT PASS
-- (RC-merchant-09; J-merchant-04 step 6).
--
-- A payer who pays a hosted checkout by bank transfer gives the name on their bank account before the payment opens
-- (`payer_names`, one row per payment, never changed). When the bank reports the transfer, the name on the account it
-- came from is compared with that one under the owner's rule (`PAY_PAYER_NAME_MATCH_RULE`), for every transfer the
-- rail counts, in the same locked transaction that would authorize the payment. All matching is captured as any
-- payment is. Anything else is held here: a different name, no name from the bank, or no rule set. A held payment
-- stays `created`: nothing is authorized, captured or settled, and no ledger entry is posted, until a review decides.
--
-- Names are kept only in these two tables; payment events carry the reason code, never a name. Neither table is ever
-- deleted from, and a payer's given name is never changed.

CREATE TABLE IF NOT EXISTS "pay"."payer_names" (
  "payment_id"  uuid PRIMARY KEY REFERENCES "pay"."payments"("id"),
  "given_name"  text NOT NULL CONSTRAINT "payer_names_given_name_length" CHECK (length(btrim("given_name")) BETWEEN 1 AND 140),
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "pay"."payer_name_holds" (
  "payment_id"     uuid PRIMARY KEY REFERENCES "pay"."payments"("id"),
  "merchant_id"    uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "reason"         text NOT NULL CONSTRAINT "payer_name_holds_reason" CHECK (
                     "reason" IN ('pay.payer_name_mismatch', 'pay.payer_name_missing', 'pay.name_match_rule_unset')),
  -- The rule the names were compared under; null when none was set.
  "rule"           text CONSTRAINT "payer_name_holds_rule" CHECK ("rule" IS NULL OR "rule" IN ('exact_normalised')),
  -- The name on the sending account of every transfer counted towards the payment when it was held, as the bank
  -- reported each (an element is null for a transfer reported with no name).
  "received_names" text[] NOT NULL CONSTRAINT "payer_name_holds_received_names" CHECK (cardinality("received_names") > 0),
  -- Everything that had arrived for the payment when it was held. Decimal, never a float.
  "amount"         numeric(38, 18) NOT NULL CONSTRAINT "payer_name_holds_amount_positive" CHECK ("amount" > 0),
  "currency"       text NOT NULL,
  -- Held until a review decides; the review's outcomes arrive with the review.
  "status"         text NOT NULL DEFAULT 'held' CONSTRAINT "payer_name_holds_status" CHECK ("status" IN ('held')),
  "held_at"        timestamptz NOT NULL DEFAULT now()
);

-- The review queue reads the oldest held first.
CREATE INDEX IF NOT EXISTS "payer_name_holds_queue_idx" ON "pay"."payer_name_holds" ("status", "held_at");

CREATE OR REPLACE FUNCTION "pay"."payer_names_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.payer_names: a payer''s given name is never changed or removed.' USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "payer_names_kept_trg" ON "pay"."payer_names";
CREATE TRIGGER "payer_names_kept_trg" BEFORE UPDATE OR DELETE ON "pay"."payer_names"
  FOR EACH ROW EXECUTE FUNCTION "pay"."payer_names_kept"();

CREATE OR REPLACE FUNCTION "pay"."payer_name_holds_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.payer_name_holds: a hold is never removed.' USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "payer_name_holds_kept_trg" ON "pay"."payer_name_holds";
CREATE TRIGGER "payer_name_holds_kept_trg" BEFORE DELETE ON "pay"."payer_name_holds"
  FOR EACH ROW EXECUTE FUNCTION "pay"."payer_name_holds_kept"();

-- PP-send-request-10 (J-pay-01 #6): a personal send the owner's review rule holds. A held send is an instruction, not
-- money: nothing is taken from the sender and nothing is reserved while it waits, as a global send on hold. When the
-- review releases it, the same transfer id is sent through the normal path, which checks the terms and the balance then;
-- when it is rejected, nothing ever moved. No balance column, no second book.
CREATE TABLE IF NOT EXISTS "bank"."personal_send_reviews" (
  "transfer_id" text PRIMARY KEY,
  "from_user_id" text NOT NULL,
  "from_space_id" uuid NOT NULL,
  "to_user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "note" text,
  "reference" text,
  -- The request this send settles, claimed only when the review releases it.
  "request_id" uuid,
  "from_handle" text,
  "to_handle" text,
  -- Why it is held, as a class the customer is shown ("amount_over_review_line"); never the rule's own figures.
  "reason_class" text NOT NULL,
  "status" text NOT NULL DEFAULT 'in_review',
  "decided_by" text,
  "ledger_tx_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  CONSTRAINT "personal_send_reviews_id_ck" CHECK (length(btrim("transfer_id")) BETWEEN 8 AND 64),
  CONSTRAINT "personal_send_reviews_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "personal_send_reviews_reason_ck" CHECK ("reason_class" IN ('amount_over_review_line')),
  CONSTRAINT "personal_send_reviews_status_ck" CHECK ("status" IN ('in_review', 'released', 'rejected')),
  CONSTRAINT "personal_send_reviews_decided_ck" CHECK (
    ("status" = 'in_review' AND "decided_at" IS NULL AND "decided_by" IS NULL AND "ledger_tx_id" IS NULL)
    OR ("status" = 'rejected' AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL AND "ledger_tx_id" IS NULL)
    OR ("status" = 'released' AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL AND "ledger_tx_id" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "personal_send_reviews_from_idx"
  ON "bank"."personal_send_reviews" ("from_user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "personal_send_reviews_open_idx"
  ON "bank"."personal_send_reviews" ("created_at")
  WHERE "status" = 'in_review';

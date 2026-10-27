-- A returned withdrawal goes back to the person's available balance (W-withdraw-07, J-wallet-06 #6). The returned-funds
-- recipe (`withdrawReturned`) now exists: a second founder, never the one who recorded the return, approves the credit,
-- and svc-pay posts it once, keyed on the settled attempt. Recorded returns stay append-only, so the approval and the
-- posting are rows of their own, written in that order: the approval before anything is posted, the posting after the
-- ledger acknowledged it. An approval with no posting is a credit whose ledger answer is not known yet; the same founder
-- action again posts the same key and records it.
--
-- A return also says why it came back in words the customer may read (`reason_code`); the free-text `reason` stays
-- with the founders. Rows recorded before this have no code.
ALTER TABLE "pay"."withdrawal_returns" ADD COLUMN IF NOT EXISTS "reason_code" text;
ALTER TABLE "pay"."withdrawal_returns" DROP CONSTRAINT IF EXISTS "withdrawal_returns_reason_code_ck";
ALTER TABLE "pay"."withdrawal_returns" ADD CONSTRAINT "withdrawal_returns_reason_code_ck"
  CHECK ("reason_code" IS NULL OR "reason_code" IN ('destination_rejected', 'network_returned', 'other'));

CREATE TABLE IF NOT EXISTS "pay"."withdrawal_return_credits" (
  "withdrawal_id" uuid PRIMARY KEY REFERENCES "pay"."withdrawal_returns" ("withdrawal_id"),
  "approved_by" text NOT NULL,
  "note" text NOT NULL,
  -- The ledger's withdrawal id the settle was posted under (`<withdrawal id>:<attempt>`): the credit's key is built from it.
  "ledger_withdrawal_id" text NOT NULL,
  "approved_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "withdrawal_return_credits_text_ck" CHECK (length(btrim("approved_by")) > 0 AND length(btrim("note")) > 0
    AND length(btrim("ledger_withdrawal_id")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."withdrawal_return_postings" (
  "withdrawal_id" uuid PRIMARY KEY REFERENCES "pay"."withdrawal_return_credits" ("withdrawal_id"),
  "ledger_tx_id" text NOT NULL,
  "posted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "withdrawal_return_postings_tx_ck" CHECK (length(btrim("ledger_tx_id")) > 0)
);

DROP TRIGGER IF EXISTS "withdrawal_return_credits_append_only_trg" ON "pay"."withdrawal_return_credits";
CREATE TRIGGER "withdrawal_return_credits_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."withdrawal_return_credits"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_returns_append_only"();

DROP TRIGGER IF EXISTS "withdrawal_return_postings_append_only_trg" ON "pay"."withdrawal_return_postings";
CREATE TRIGGER "withdrawal_return_postings_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."withdrawal_return_postings"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_returns_append_only"();

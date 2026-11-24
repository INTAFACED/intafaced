-- svc-ledger · durable ledgerTxPosted outbox
-- Reversal: 0013_tx_posted_outbox.down.sql
--
-- engine.post commits the book, then the service published `ledgerTxPosted`.
-- A crash between COMMIT and publish lost the event: the movement is in the
-- journal and no consumer ever hears it. Catalog Class A (no subscriber yet)
-- does not change that — the intent still has to survive the process.
--
-- The row is written in the SAME transaction as ledger_tx / entries / balances.
-- Publish happens after commit; published_at is set only after the bus accepts.
-- Recover on boot/tick republishes unpublished rows once.
--
-- CHECK seals payload object + entries array only. Postgres forbids subqueries
-- in CHECK (NOT EXISTS / jsonb_array_elements), so amount-as-string is
-- application law: formatAmount on write, ledgerTxPostedPayload on publish.

CREATE TABLE "ledger"."ledger_tx_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tx_id" uuid NOT NULL,
  "payload" jsonb NOT NULL,
  "correlation_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone,
  CONSTRAINT "ledger_tx_outbox_amount_string_ck" CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload->'entries') = 'array')
);

ALTER TABLE "ledger"."ledger_tx_outbox" ADD CONSTRAINT "ledger_tx_outbox_tx_id_fkey" FOREIGN KEY ("tx_id") REFERENCES "ledger"."ledger_tx"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "ledger_tx_outbox_tx_idx" ON "ledger"."ledger_tx_outbox" USING btree ("tx_id");

CREATE INDEX "ledger_tx_outbox_unpublished_idx" ON "ledger"."ledger_tx_outbox" USING btree ("created_at") WHERE published_at IS NULL;

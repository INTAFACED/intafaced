-- svc-ledger · durable ledgerFreezeUpdated outbox
-- Reversal: 0020_freeze_event_outbox.down.sql
--
-- freeze and unfreeze commit posting_freeze, then publish ledgerFreezeUpdated.
-- The publish used to sit after that commit with no outbox. A bus throw left
-- the switch moved, and a retry with the same reason and actor is a true
-- no-op of the switch, so the event never left. ledgerTxPosted already
-- survives that gap: the intent is written in the same transaction as the
-- book, and boot, tick, and retry publish unpublished rows. This table is
-- that intent for the control-plane event. It is not a second book and not a
-- second bus. The payload is frozen, reason, actor, and changedAt. It holds
-- no amount.

CREATE TABLE "ledger"."ledger_freeze_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone,
  CONSTRAINT "ledger_freeze_outbox_payload_ck" CHECK (coalesce(jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'frozen') = 'boolean' AND jsonb_typeof(payload -> 'actor') = 'string' AND length(payload ->> 'actor') > 0 AND jsonb_typeof(payload -> 'changedAt') = 'string' AND length(payload ->> 'changedAt') > 0 AND (((payload ->> 'frozen') = 'false' AND jsonb_typeof(payload -> 'reason') = 'null') OR ((payload ->> 'frozen') = 'true' AND jsonb_typeof(payload -> 'reason') = 'string' AND length(payload ->> 'reason') > 0)), false))
);

CREATE UNIQUE INDEX "ledger_freeze_outbox_key_idx" ON "ledger"."ledger_freeze_outbox" USING btree ("idempotency_key");

CREATE INDEX "ledger_freeze_outbox_unpublished_idx" ON "ledger"."ledger_freeze_outbox" USING btree ("created_at") WHERE published_at IS NULL;

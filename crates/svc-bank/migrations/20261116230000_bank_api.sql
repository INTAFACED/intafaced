-- I connect my systems to the bank API (J-bank-24; BK-bdev-01, BK-bdev-02). The person's money is the partner bank's
-- (OWNER 226): every balance the API lists is the partner's figure, a move between their own accounts is one partner move on
-- the partner's quote, and a payment out is the partner's, over its rail. These tables hold only the intent rows written
-- before the partner is asked, the transfer states the partner reported, and the person's webhook endpoints and deliveries.
-- Never a balance. The ledger posts nothing for any of it.
--
-- Reversal: 20261116230000_bank_api.down.sql

-- A partner quote for a move between two of the person's own accounts, kept with its exact figures until its valid-until.
CREATE TABLE IF NOT EXISTS "bank"."api_move_quotes" (
  "quote_id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "from_space_id" uuid NOT NULL REFERENCES "bank"."spaces" ("id"),
  "to_space_id" uuid NOT NULL REFERENCES "bank"."spaces" ("id"),
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "fee" numeric(38, 18),
  "receives" numeric(38, 18),
  "label" text NOT NULL,
  "quoted_at" timestamptz NOT NULL,
  "valid_until" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "api_move_quotes_amount_ck" CHECK ("amount" > 0)
);
CREATE INDEX IF NOT EXISTS "api_move_quotes_user_idx" ON "bank"."api_move_quotes" ("user_id", "created_at");

-- A move asked through the API, keyed by the caller's dedupe id: written before the partner is asked, so a lost answer
-- keeps the row and a retry under the same id asks the partner under the same key.
CREATE TABLE IF NOT EXISTS "bank"."api_moves" (
  "user_id" text NOT NULL,
  "dedupe_id" text NOT NULL,
  "quote_id" text NOT NULL REFERENCES "bank"."api_move_quotes" ("quote_id"),
  "partner_key" text NOT NULL UNIQUE,
  "state" text NOT NULL,
  "partner_move_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  PRIMARY KEY ("user_id", "dedupe_id"),
  CONSTRAINT "api_moves_state_ck" CHECK ("state" IN ('pending', 'completed')),
  CONSTRAINT "api_moves_completed_ck" CHECK (("state" = 'completed') = ("partner_move_id" IS NOT NULL))
);

-- A payment out asked through the API, keyed by the caller's idempotency key (business key `pay:<user>:<key>`), written
-- before the partner is asked. With no rail it is kept `refused` with `rail.bank`.
CREATE TABLE IF NOT EXISTS "bank"."api_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "partner_key" text NOT NULL UNIQUE,
  "from_space_id" uuid NOT NULL REFERENCES "bank"."spaces" ("id"),
  "asset_id" text NOT NULL,
  "method" text NOT NULL,
  "recipient" jsonb NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "state" text NOT NULL,
  "refusal_code" text,
  "partner_payment_id" text,
  "version" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "api_payments_key_uq" UNIQUE ("user_id", "idempotency_key"),
  CONSTRAINT "api_payments_method_ck" CHECK ("method" IN ('instant', 'ach')),
  CONSTRAINT "api_payments_state_ck" CHECK ("state" IN ('asked', 'refused', 'pending', 'completed', 'cancelled', 'reversed')),
  CONSTRAINT "api_payments_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "api_payments_refused_ck" CHECK (("state" = 'refused') = ("refusal_code" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "api_payments_user_idx" ON "bank"."api_payments" ("user_id", "created_at");

-- Each change of a payment's state as the partner reported it, once per (payment, version): a replayed report adds nothing.
CREATE TABLE IF NOT EXISTS "bank"."api_transfer_events" (
  "event_id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "payment_id" uuid NOT NULL REFERENCES "bank"."api_payments" ("id"),
  "version" integer NOT NULL,
  "previous_state" text,
  "current_state" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "api_transfer_events_once_uq" UNIQUE ("payment_id", "version")
);

-- The person's webhook endpoints. The signing secret is shown once, at create.
CREATE TABLE IF NOT EXISTS "bank"."api_webhook_endpoints" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "url" text NOT NULL,
  "secret" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "disabled_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "api_webhook_endpoints_user_idx" ON "bank"."api_webhook_endpoints" ("user_id", "created_at");

-- One delivery of one event to one endpoint, with every attempt counted.
CREATE TABLE IF NOT EXISTS "bank"."api_webhook_deliveries" (
  "event_id" text NOT NULL REFERENCES "bank"."api_transfer_events" ("event_id"),
  "endpoint_id" uuid NOT NULL REFERENCES "bank"."api_webhook_endpoints" ("id"),
  "user_id" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_status" integer,
  "last_error" text,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "lease_until" timestamptz,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("event_id", "endpoint_id"),
  CONSTRAINT "api_webhook_deliveries_state_ck" CHECK ("state" IN ('pending', 'delivered', 'failed'))
);
CREATE INDEX IF NOT EXISTS "api_webhook_deliveries_due_idx" ON "bank"."api_webhook_deliveries" ("next_attempt_at") WHERE "state" = 'pending';

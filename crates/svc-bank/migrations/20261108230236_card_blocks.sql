-- svc-bank · a cardholder's card controls and the card's lock history (BK-cctl-01, J-bank-14 #1)
-- Reversal: 20261108230236_card_blocks.down.sql
--
-- A control blocks one merchant category, one merchant or one country for one card; an authorisation that names a
-- blocked one declines before anything is held, with its own code. Adding a block that is already live returns it;
-- lifting one keeps the row with its time. A status event is one change of the card's status (frozen, active again,
-- closed) with who made it (the owner, a holder, an operator, or a single-use card's own rule), so the temporary lock has a history. The merchant and its country are kept on each
-- authorisation as the issuer sent them. Nothing here is a balance and no value moves.

CREATE TABLE IF NOT EXISTS "bank"."card_controls" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "card_id"     uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "kind"        text NOT NULL,
  "value"       text NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "lifted_at"   timestamptz,
  CONSTRAINT "card_controls_kind_ck" CHECK ("kind" IN ('category', 'merchant', 'country'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "card_controls_live_uq" ON "bank"."card_controls" ("card_id", "kind", "value") WHERE "lifted_at" IS NULL;

CREATE TABLE IF NOT EXISTS "bank"."card_status_events" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "card_id"     uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "status"      text NOT NULL,
  "actor"       text NOT NULL,
  "at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "card_status_events_status_ck" CHECK ("status" IN ('active', 'frozen', 'closed')),
  CONSTRAINT "card_status_events_actor_ck" CHECK ("actor" IN ('owner', 'holder', 'operator', 'system'))
);
CREATE INDEX IF NOT EXISTS "card_status_events_card_idx" ON "bank"."card_status_events" ("card_id", "at");

ALTER TABLE "bank"."card_authorizations" ADD COLUMN IF NOT EXISTS "merchant" text;
ALTER TABLE "bank"."card_authorizations" ADD COLUMN IF NOT EXISTS "merchant_country" text;

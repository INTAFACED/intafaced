-- Pay yourself from your trading (J-bank-31). A move is one venue withdrawal, signed once in the person's own wallet,
-- to their own account at the partner bank: the venue and the partner hold the money and its record, and the ledger
-- posts nothing. These rows record only what the person asked for: each move's business key, the venue's nonce for the
-- withdrawal once it is signed, and the weekly rule that prepares a move for one signature. No balance lives here.
--
-- Reversal: the matching .down.sql

CREATE TABLE IF NOT EXISTS "bank"."pay_yourself_rules" (
  "id" uuid PRIMARY KEY,
  -- One rule per person: setting it again changes it.
  "user_id" text NOT NULL UNIQUE,
  -- ISO weekday the rule runs on (1 Monday … 7 Sunday).
  "weekday" smallint NOT NULL,
  "asset_id" text NOT NULL,
  -- The most one week's move may be.
  "cap" numeric(38, 18) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- When the rule last prepared (or found nothing to prepare); the next week's profit is counted from here.
  "last_run_at" timestamptz,
  "next_run_at" timestamptz NOT NULL,
  CONSTRAINT "pay_yourself_rules_weekday_ck" CHECK ("weekday" BETWEEN 1 AND 7),
  CONSTRAINT "pay_yourself_rules_cap_ck" CHECK ("cap" > 0)
);

CREATE TABLE IF NOT EXISTS "bank"."pay_yourself_moves" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  -- The business key the venue withdrawal is stored under: one key is one move, ever.
  "move_key" text NOT NULL UNIQUE,
  -- manual: asked for by the person; rule: prepared by their weekly rule, waiting for their signature.
  "source" text NOT NULL,
  "rule_id" uuid,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  -- prepared: waiting for the person's one signature, nothing moved; sent: signed and taken by the venue.
  "status" text NOT NULL,
  -- The venue account's owner wallet, lowercase; and the venue's nonce for the signed withdrawal once sent.
  "owner" text,
  "venue_nonce" text,
  -- The window of realised profit a rule's move was made from.
  "window_from" timestamptz,
  "window_to" timestamptz,
  "prepared_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  CONSTRAINT "pay_yourself_moves_key_ck" CHECK (length("move_key") BETWEEN 8 AND 160),
  CONSTRAINT "pay_yourself_moves_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "pay_yourself_moves_source_ck" CHECK ("source" IN ('manual', 'rule')),
  CONSTRAINT "pay_yourself_moves_status_ck" CHECK ("status" IN ('prepared', 'sent')),
  CONSTRAINT "pay_yourself_moves_sent_ck" CHECK (("status" = 'sent') = ("venue_nonce" IS NOT NULL AND "sent_at" IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS "pay_yourself_moves_user_idx" ON "bank"."pay_yourself_moves" ("user_id", "prepared_at");

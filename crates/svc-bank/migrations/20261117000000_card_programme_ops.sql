-- J-bank-26 (BK-cops-01 to BK-cops-03, BK-cops-06 to BK-cops-08): support and finance run the card programme. Every table
-- here is a RECORD or a POLICY: the programme's configuration, its authorisation rules and 3DS policy, the trace of why
-- each authorisation was decided, cardholders and their review queue, staff roles, the audit log and bulk issue files.
-- Nothing here holds a balance and nothing posts to the ledger; card money stays the partner's (OWNER 226).

-- One row per setting (programme, product, bin, fees, threeds), its value as last saved, and its version.
CREATE TABLE IF NOT EXISTS "bank"."card_programme_settings" (
  "key" text PRIMARY KEY CHECK ("key" IN ('programme', 'product', 'bin', 'fees', 'threeds')),
  "value" jsonb NOT NULL,
  "version" integer NOT NULL CHECK ("version" > 0),
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- An authorisation rule, one row per version. A new rule starts in shadow (it decides nothing) with the result of its
-- run over past TEST authorisations; promoting makes it decide new authorisations only; rolling back retires it and puts
-- the version before it back. Past decisions are rows of their own and never change.
CREATE TABLE IF NOT EXISTS "bank"."card_programme_rules" (
  "id" uuid PRIMARY KEY,
  "rule_key" text NOT NULL,
  "version" integer NOT NULL CHECK ("version" > 0),
  "name" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('amount_above', 'merchant_category', 'channel')),
  "params" jsonb NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('shadow', 'active', 'retired')),
  "shadow_evaluated" integer NOT NULL CHECK ("shadow_evaluated" >= 0),
  "shadow_would_decline" integer NOT NULL CHECK ("shadow_would_decline" >= 0 AND "shadow_would_decline" <= "shadow_evaluated"),
  "shadow_at" timestamptz NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "promoted_at" timestamptz,
  "retired_at" timestamptz,
  UNIQUE ("rule_key", "version")
);
-- At most one version of a rule decides at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "card_programme_rules_one_active" ON "bank"."card_programme_rules" ("rule_key") WHERE "state" = 'active';

-- Why one authorisation was approved or declined: each check in order with its answer, written once beside the decision.
CREATE TABLE IF NOT EXISTS "bank"."card_authorization_traces" (
  "authorization_id" uuid PRIMARY KEY REFERENCES "bank"."card_authorizations" ("id"),
  "steps" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- A person or business that can hold the programme's cards. A cardholder whose gate failed is still recorded, in review,
-- with the gap named, so the review queue shows it.
CREATE TABLE IF NOT EXISTS "bank"."card_cardholders" (
  "id" uuid PRIMARY KEY,
  "request_key" text NOT NULL UNIQUE,
  "kind" text NOT NULL CHECK ("kind" IN ('individual', 'business')),
  "name" text NOT NULL,
  "email" text,
  "country" text NOT NULL,
  -- The app account an individual cardholder is, as svc-identity found it by email; null when none was found.
  "user_id" text,
  "beneficial_owners" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL CHECK ("status" IN ('verified', 'review')),
  "gap" text,
  "gap_code" text,
  "screening" text NOT NULL CHECK ("screening" IN ('clear', 'listed')),
  "screened_at" timestamptz NOT NULL,
  "test" boolean NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "card_cardholders_review_names_gap" CHECK (("status" = 'review') = ("gap" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "card_cardholders_status_idx" ON "bank"."card_cardholders" ("status", "created_at");

-- Staff roles on the card programme. A role narrows what an operator may do here; it never widens a session's scopes.
CREATE TABLE IF NOT EXISTS "bank"."card_programme_staff" (
  "user_id" text PRIMARY KEY,
  "email" text NOT NULL,
  "role" text NOT NULL CHECK ("role" IN ('manager', 'viewer')),
  "assigned_by" text NOT NULL,
  "assigned_at" timestamptz NOT NULL DEFAULT now()
);

-- Every change on the card programme desk: who, what, the value before and after, and when. Written once, never edited.
CREATE TABLE IF NOT EXISTS "bank"."card_programme_audit" (
  "id" bigserial PRIMARY KEY,
  "actor" text NOT NULL,
  "action" text NOT NULL,
  "target" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "at" timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION "bank"."card_programme_audit_written_once"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bank.card_programme_audit is written once and never edited or removed';
END;
$$;
DROP TRIGGER IF EXISTS "card_programme_audit_written_once" ON "bank"."card_programme_audit";
CREATE TRIGGER "card_programme_audit_written_once" BEFORE UPDATE OR DELETE ON "bank"."card_programme_audit"
  FOR EACH ROW EXECUTE FUNCTION "bank"."card_programme_audit_written_once"();

-- One bulk issue file, by the SHA-256 of its rows: issuing the same file again is the same batch and the same cards.
CREATE TABLE IF NOT EXISTS "bank"."card_bulk_batches" (
  "id" text PRIMARY KEY,
  "rows" integer NOT NULL CHECK ("rows" > 0),
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "bank"."card_bulk_cards" (
  "batch_id" text NOT NULL REFERENCES "bank"."card_bulk_batches" ("id"),
  "row_no" integer NOT NULL CHECK ("row_no" > 0),
  "cardholder_id" uuid NOT NULL REFERENCES "bank"."card_cardholders" ("id"),
  "card_id" uuid NOT NULL UNIQUE REFERENCES "bank"."cards" ("id"),
  PRIMARY KEY ("batch_id", "row_no")
);

-- A card moved from one cardholder to another. Moves no value: a card holds none.
CREATE TABLE IF NOT EXISTS "bank"."card_reassignments" (
  "id" uuid PRIMARY KEY,
  "card_id" uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "from_user_id" text NOT NULL,
  "to_cardholder_id" uuid NOT NULL REFERENCES "bank"."card_cardholders" ("id"),
  "actor" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now()
);

-- THE SUB-MERCHANT TREE, AND THE PERMISSIONS OVER IT (§6.1 PayFac mode).
--
-- ── WHAT WAS ACTUALLY IN THE WAY ───────────────────────────────────────────
--
-- `pay.merchants` had no parent column and a UNIQUE index on `user_id`, so
-- "one merchant per sovereign account, and no merchant is under any other" was
-- a database fact, not a missing feature. `merchant.create` has accepted
-- `mode: 'payfac'` since 0000 and it changed nothing at all — a payfac and a
-- gateway merchant were the same row with a different word in a column.
--
-- ── THE ONE HARD CONSTRAINT THE SPEC STATES ────────────────────────────────
--
-- `docs/SPEC-PAY-VERTICALS-2026-08-02.md` §2, verbatim:
--
--   "Design constraint that keeps the door open: model the sub-merchant
--    relationship so the *settling party* is a field, not an assumption. If it
--    is hardcoded as us, adopting a partner later is a rewrite; if it is a party
--    reference, it is configuration."
--
-- So `settling_party` is a column here rather than an assumption in settlement
-- code. It defaults to `'self'`, which is exactly what settlement does today —
-- a merchant settles into its own ledger account. Any other value is REFUSED at
-- the service boundary (`pay.submerchant_settling_party_unsupported`) rather
-- than accepted and ignored: settling a sub-merchant out of our own account is
-- acquiring, it needs a sponsor bank, and §8 of that spec puts the sponsor on
-- the owner's list. A column that records an intent nothing honours would be a
-- lie stored in a table.
--
-- ── NO BALANCE, NO VALUE, NO LEDGER ────────────────────────────────────────
--
-- Nothing in this migration holds money or moves it. A sub-merchant IS a
-- sovereign account exactly as a merchant is (Doctrine §0.6) — value still sits
-- in the ledger and still moves only through `packages/ledger-client`. The tree
-- decides WHO MAY ASK, never where value is.

-- ── 1 · THE TREE ───────────────────────────────────────────────────────────

ALTER TABLE "pay"."merchants"
  -- NULL means "this merchant is the top of its own tree". An ordinary gateway
  -- merchant is a tree of one, so nothing about existing rows changes and no
  -- backfill is required.
  ADD COLUMN IF NOT EXISTS "parent_merchant_id" uuid REFERENCES "pay"."merchants"("id"),

  -- WHO SETTLES THIS MERCHANT. `'self'` (today's only supported value) means the
  -- merchant's own ledger account. Free text rather than an enum because a
  -- sponsor is a party reference we do not have yet, and an enum written before
  -- the relationship exists would be a guess at its shape.
  ADD COLUMN IF NOT EXISTS "settling_party" text NOT NULL DEFAULT 'self'
    CONSTRAINT "merchants_settling_party_not_blank" CHECK (length(btrim("settling_party")) > 0);

DO $$
BEGIN
  -- A merchant that is its own parent is a one-node cycle, and the ancestor walk
  -- would spin on it. The walk is bounded anyway, but a shape the database can
  -- refuse outright should not be left to application code to survive.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merchants_parent_not_self') THEN
    ALTER TABLE "pay"."merchants"
      ADD CONSTRAINT "merchants_parent_not_self"
      CHECK ("parent_merchant_id" IS NULL OR "parent_merchant_id" <> "id");
  END IF;
END $$;

-- The query the tree walk actually runs: "who are this node's children".
CREATE INDEX IF NOT EXISTS "merchants_parent_idx"
  ON "pay"."merchants" ("parent_merchant_id");

-- ── 2 · THE PERMISSIONS ────────────────────────────────────────────────────
--
-- AN APPEND-ONLY JOURNAL, NOT A MUTABLE GRANT TABLE.
--
-- The effective permission is the LATEST event for a `(grantee, subject, area)`
-- triple: `grant` means held, `revoke` means not. A revoke is therefore a new
-- row, never an UPDATE and never a DELETE — the same rule
-- `pay.merchant_status_events` follows, and for the same reason. "Who could
-- refund this sub-merchant's payments on the 3rd" is a question a dispute is
-- argued from, and a table where the answer can be edited afterwards is not
-- evidence. The trigger below enforces it rather than trusting the application.
--
-- `actor_merchant_id` is recorded alongside `actor_id` because authority here is
-- held by a NODE IN A TREE, not by a person: the same human may hold two
-- merchants, and "which node was this delegated from" is the fact that makes the
-- delegation checkable later.

CREATE TABLE IF NOT EXISTS "pay"."merchant_permission_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The total order. `now()` inside a transaction is the transaction's start
  -- time, so a grant and the revoke that corrects it in one statement would
  -- share a timestamp and could not be ordered by it.
  "seq" bigserial NOT NULL,

  -- WHO HOLDS IT — an ancestor node of the subject.
  "grantee_merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),

  -- WHAT IT IS OVER — a descendant node.
  "subject_merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),

  -- The permission area. Text, validated against `PERMISSION_AREAS` in
  -- `src/submerchants.ts`, and deliberately NOT a Postgres enum: the area list
  -- is not settled product law (see that file), and an enum makes every future
  -- correction a migration against a live table.
  "area" text NOT NULL,

  "action" text NOT NULL
    CONSTRAINT "merchant_permission_events_action_known" CHECK ("action" IN ('grant', 'revoke')),

  -- REQUIRED, and free text on purpose — the same argument as the merchant
  -- status history. "Why does this node hold refund authority over that one" has
  -- to be answerable from the database, and it is not answerable from NULL.
  "reason" text NOT NULL
    CONSTRAINT "merchant_permission_events_reason_not_blank" CHECK (length(btrim("reason")) > 0),

  -- WHO DID IT: the authenticated principal, and the merchant node they were
  -- acting as. Never from a request body.
  "actor_id" text NOT NULL,
  "actor_merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "actor_scope" text NOT NULL,

  "created_at" timestamptz NOT NULL DEFAULT now(),

  -- A grant over YOURSELF is meaningless: a merchant already holds every area
  -- over its own node, which is what owning your own merchant means. Storing one
  -- would create a row that can be "revoked" while changing nothing — a revoke
  -- an operator would read as having taken authority away.
  CONSTRAINT "merchant_permission_events_not_self"
    CHECK ("grantee_merchant_id" <> "subject_merchant_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_permission_events_seq_idx"
  ON "pay"."merchant_permission_events" ("seq");

-- THE AUTHORIZATION LOOKUP, which runs on every scoped call: latest event for
-- one triple. Descending `seq` so the answer is the index's first row.
CREATE INDEX IF NOT EXISTS "merchant_permission_events_triple_idx"
  ON "pay"."merchant_permission_events" ("grantee_merchant_id", "subject_merchant_id", "area", "seq" DESC);

-- "Who can do what to this sub-merchant" — the console query, and the one a
-- sub-merchant is entitled to ask about itself.
CREATE INDEX IF NOT EXISTS "merchant_permission_events_subject_idx"
  ON "pay"."merchant_permission_events" ("subject_merchant_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."merchant_permission_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.merchant_permission_events is append-only: % is not permitted. Revoke with a new row, do not edit the old one.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "merchant_permission_events_append_only_trg" ON "pay"."merchant_permission_events";
CREATE TRIGGER "merchant_permission_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."merchant_permission_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."merchant_permission_events_append_only"();

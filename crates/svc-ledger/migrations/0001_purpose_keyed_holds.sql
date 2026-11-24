-- intafaced:destructive drops the index accounts_identity_idx, superseded in this
-- same migration by the wider unique index accounts_identity_purpose_idx, which
-- adds "purpose" to the key. Nothing it enforced is lost; it is a strict widening.
-- svc-ledger · P0-3 purpose-keyed holds
-- Reversal: 0001_purpose_keyed_holds.down.sql
--
-- An account's identity gains a fifth component. Before this, `hold` was one
-- bucket per (user, asset): an order reservation and an in-flight withdrawal
-- shared a balance, so `withdraw.settle` could draw down value an open order
-- was relying on. Both entries balance, the hash chain verifies, reconciliation
-- passes — and the order is silently unfunded, with nothing in the book able to
-- say which hold was consumed, because no such distinction was ever recorded.

-- NOT NULL DEFAULT '' rather than a nullable column, deliberately.
--
-- In a standard UNIQUE index Postgres treats NULLs as DISTINCT, so a nullable
-- `purpose` would let ('user','u1','BTC','hold',NULL) be inserted twice and the
-- constraint would raise nothing. The commingled bucket would come back as
-- duplicate rows instead of one shared row — strictly worse, because the
-- balance would then be split across accounts that look identical.
--
-- '' is the honest normal form for "this account kind has no sub-identity".
ALTER TABLE "ledger"."accounts"
  ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT '';

-- BACKFILL — and an honest admission about what cannot be backfilled.
--
-- An existing `hold` row has a balance whose purpose is genuinely unknowable:
-- not recording it is precisely the bug being fixed, so there is nothing to
-- recover it from. Guessing would be worse than admitting it.
--
-- Each pre-existing hold therefore becomes its OWN purpose keyed on its account
-- id. That preserves every balance exactly, merges nothing, and keeps the rows
-- distinct — while labelling them so nobody mistakes them for attributed value.
--
-- OPERATIONAL CONSEQUENCE, stated rather than buried: a `legacy:` hold cannot
-- be released by `orderHoldRelease` or `withdrawSettle`, because those look for
-- `order:<id>` / `withdraw:<id>`. Any that exist must be resolved by hand
-- against the module that placed them. At the time of writing nothing is
-- deployed, so in every real environment this UPDATE matches zero rows.
UPDATE "ledger"."accounts"
   SET "purpose" = 'legacy:' || "id"::text
 WHERE "kind" = 'hold' AND "purpose" = '';

-- Bounded because it participates in an index, and because a purpose is a
-- business key ('order:<uuid>'), never free-form metadata.
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_purpose_len_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_purpose_len_ck"
  CHECK (length("purpose") <= 128);

-- Only `hold` requires a purpose. `escrow`, `stake` and `collateral` are keyed
-- by their own business object elsewhere, and an `available` balance is
-- fungible with itself — giving it a purpose would fragment it for nothing.
--
-- The service asserts this too (assertPurposedHolds). Belt and braces: the
-- database is the last thing standing between a bug and a book that cannot say
-- whose money moved.
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_hold_purposed_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_hold_purposed_ck"
  CHECK ("kind" <> 'hold' OR length("purpose") > 0);

-- Swap the identity index. Created first, dropped second: at no point is the
-- table without a uniqueness guarantee on account identity.
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_identity_purpose_idx"
  ON "ledger"."accounts" ("owner_type", "owner_id", "asset_id", "kind", "purpose");

DROP INDEX IF EXISTS "ledger"."accounts_identity_idx";

-- Answers "what is held for this user, broken down by what it is held for"
-- without a sequential scan — the query an operator runs when a customer asks
-- why their balance is short.
CREATE INDEX IF NOT EXISTS "accounts_hold_purpose_idx"
  ON "ledger"."accounts" ("owner_id", "asset_id", "purpose")
  WHERE "kind" = 'hold';

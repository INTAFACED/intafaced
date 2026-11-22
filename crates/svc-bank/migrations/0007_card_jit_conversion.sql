-- svc-bank — JUST-IN-TIME CONVERSION ON A CARD SPEND (§18), CUSTODIAL HALF
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS, AND WHAT IT POINTEDLY DOES NOT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 0003 shipped a card bound to ONE asset, authorised for an amount already
-- denominated in that asset. §18 describes something else: a merchant charges in
-- a settlement currency and the spend pulls the equivalent out of a DIFFERENT
-- asset at the authorisation moment. There was no settlement currency in the
-- schema, so there was nothing to convert, and "JIT conversion" named a step
-- that did not exist.
--
-- Two things arrive: `cards.settlement_asset_id` — what merchants charge this
-- card in — and one row per authorisation recording the rate it converted at.
--
-- WHAT DOES NOT ARRIVE IS A SECOND MOVEMENT. Nothing on our book is exchanged.
-- The funding asset still goes available → hold → `rail/<issuer>/<funding asset>`
-- through the same three ledger recipes; the row below decides only HOW MANY
-- units that is. The counterparty who hands the merchant settlement currency and
-- takes our funding asset at the boundary is `socket.live-issuer`, and this
-- service does not book its leg — doing so would be a second money book with a
-- partner's name on it.
--
-- AND NO RATE IS STORED AS POLICY. There is no `bank.rates` table here and there
-- must never be one. This platform has no FX source; a rate we wrote down would
-- be a rate we invented. Every row below carries a rate a feed HANDED us at a
-- named instant, as a record of what happened, and the deployment that has no
-- rate adapter simply cannot write one of these rows at all.

-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT MERCHANTS CHARGE THIS CARD IN.
--
-- Backfilled to the funding asset, which is exactly what every existing card
-- means today: charged in the asset it draws on, so no conversion, so no rate,
-- so nothing about those cards changes. NOT NULL after the backfill because a
-- card that cannot say what currency it is charged in cannot decide whether it
-- needs a rate — and "needs a rate" is the branch that decides whether the whole
-- authorisation refuses.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "bank"."cards" ADD COLUMN IF NOT EXISTS "settlement_asset_id" text;
UPDATE "bank"."cards" SET "settlement_asset_id" = "asset_id" WHERE "settlement_asset_id" IS NULL;
ALTER TABLE "bank"."cards" ALTER COLUMN "settlement_asset_id" SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE FROZEN QUOTE — one row per authorisation that needed one.
--
-- Written in the SAME database transaction as the authorisation decision, by the
-- caller that claimed that decision. That is what makes the pair impossible to
-- disagree: a second delivery of the same authorisation loses the insert on
-- `card_authorizations` and therefore never reaches this table, so there is
-- exactly one rate per purchase and it is the rate the first decision was taken
-- at.
--
-- Every column is a RECORD, written once. Nothing here accumulates, nothing is
-- re-rated, and no money path updates a row after insert. `funding_amount` is
-- not a balance — it is the size of a movement the ledger has its own record of,
-- and `bank-service.test.ts` fails the build on money columns that are not
-- declared and reasoned, which this paragraph is.
--
-- WHY THE RATE IS FROZEN AT ALL. The hold is a fixed number of funding units,
-- taken at this rate. If a capture re-quoted, a rate that moved between the
-- swipe and the clearing would settle a different number of units than were
-- held: too many overdraws an account that holds only the hold, too few leaves
-- the hold above zero with a silently wrong remainder. Either way the user is
-- charged a rate nobody showed them, days after they agreed a price at a till.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."card_conversions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "authorization_id" uuid NOT NULL REFERENCES "bank"."card_authorizations" ("id"),
  -- What the merchant charged, in the currency they charged it in.
  "settlement_asset_id" text NOT NULL,
  "settlement_amount" numeric(38, 18) NOT NULL,
  -- What the user's balance is denominated in — and the asset every ledger
  -- posting against this authorisation is in.
  "funding_asset_id" text NOT NULL,
  -- Ceil of settlement / rate. The rounding unit lands on the user, in the same
  -- direction and for the same reason cashback floors.
  "funding_amount" numeric(38, 18) NOT NULL,
  -- Settlement units per ONE funding unit. The direction `PriceSource` already
  -- returns, so nothing anywhere inverts it and there is no second convention to
  -- get backwards.
  "rate" numeric(38, 18) NOT NULL,
  -- 'mid' | 'index' | 'last', from `loans/prices.ts`. Recorded rather than
  -- inferred: an auditor asking "what kind of number moved this money" gets an
  -- answer, and 'last' is refused at the gate rather than silently accepted.
  "rate_quality" text NOT NULL,
  -- When the FEED said the rate was true, not when we wrote the row. A rate with
  -- no instant on it cannot be checked for staleness, and a stale rate is the
  -- one that empties a balance.
  "rate_as_of" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "card_conversions_settlement_positive" CHECK ("settlement_amount" > 0),
  CONSTRAINT "card_conversions_funding_positive" CHECK ("funding_amount" > 0),
  -- A zero or negative rate is a broken feed, not a free card. The gate refuses
  -- these; this is the second door, in the database, where it cannot be skipped.
  CONSTRAINT "card_conversions_rate_positive" CHECK ("rate" > 0),
  -- A conversion row exists ONLY where there is a conversion. Same-asset cards
  -- consult no rate and write nothing here, so the absence of a row is itself a
  -- readable fact rather than an ambiguity.
  CONSTRAINT "card_conversions_assets_differ" CHECK ("settlement_asset_id" <> "funding_asset_id"),
  CONSTRAINT "card_conversions_quality_known" CHECK ("rate_quality" IN ('mid', 'index', 'last'))
);

-- ONE RATE PER AUTHORISATION, FOREVER. This index is the freeze.
CREATE UNIQUE INDEX IF NOT EXISTS "card_conversions_auth_idx" ON "bank"."card_conversions" ("authorization_id");

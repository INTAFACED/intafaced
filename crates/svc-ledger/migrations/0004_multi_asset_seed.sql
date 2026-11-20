-- svc-ledger · seed the commodity and forex assets (§4.2)
-- Reversal: 0004_multi_asset_seed.down.sql
--
-- These are the assets `packages/contracts/src/instruments.ts` lists markets in.
-- `CATALOGUE_ASSETS` in that file is the authority and a test asserts its
-- contents; this file must carry every entry, because a market whose asset has
-- no row here fails at the first ledger post rather than at listing time.
--
-- Following 0000's precedent exactly: adding an asset is a data change, never a
-- code change, and the insert is idempotent so the file is re-runnable.
--
-- DECIMALS. CORRECTED 2026-08-08 (STOP §4.2b #5). This file used to claim that
-- this is "the scale the ledger reconciles the asset at, and it is not cosmetic".
-- Nothing reads the column. Every balance is `numeric(38,18)` and reconciliation
-- compares at 18 decimal places for every asset, so the values below are a
-- DECLARATION OF INTENT and change no behaviour anywhere today. The correction is
-- recorded here rather than the sentence quietly deleted, because a false safety
-- claim that vanishes without trace is how the next audit re-finds it.
--
-- The numbers themselves are kept, and are still the right numbers to declare —
-- they are what the scale should be if and when it is enforced. What that
-- enforcement does with the sub-unit remainder (`mulBps` rounds `ceil` at 18 dp,
-- so it exists) is a fee/rounding policy decision, not a correctness one. See
-- `schema.ts` at the column and `assets-decimals.test.ts`.
--   · Fiat currencies at 2, matching the existing USD/EUR/GBP rows. JPY is
--     conventionally quoted to 0 decimal places as a currency, but it is stored
--     at 2 like every other fiat here: a JPY *balance* still needs sub-unit
--     precision to hold the remainder of a USD/JPY fill, and a currency that
--     cannot represent its own fill remainder accumulates rounding dust.
--   · Commodities at 8. A troy ounce of gold is worth enough that 2 decimals
--     would make the smallest representable holding a material sum, and the
--     lot size on XAU/USD is 0.01 oz.

INSERT INTO "ledger"."assets" ("id", "kind", "decimals") VALUES
  -- Forex majors. USD, EUR and GBP are already seeded by 0000.
  ('JPY',    'fiat',      2),
  ('CHF',    'fiat',      2),
  ('CAD',    'fiat',      2),
  ('AUD',    'fiat',      2),
  -- Metals, priced per troy ounce.
  ('XAU',    'commodity', 8),
  ('XAG',    'commodity', 8),
  -- Energy. WTI and BRENT are priced per barrel, NATGAS per MMBtu.
  ('WTI',    'commodity', 8),
  ('BRENT',  'commodity', 8),
  ('NATGAS', 'commodity', 8)
ON CONFLICT ("id") DO NOTHING;

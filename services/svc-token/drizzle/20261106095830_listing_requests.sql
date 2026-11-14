-- J-dex-protocol-24 #7 (D-launch-listing-03): the express listing verification route and its fee.
-- The price is an owner value two founders publish; blank (no row, or a null price) refuses `listing.price_unset` and
-- charges nothing. Every publish is a numbered row naming who asked and who approved.
CREATE TABLE IF NOT EXISTS "token"."listing_prices" (
  "route" text PRIMARY KEY CHECK ("route" IN ('express')),
  -- Whole units of `asset_id`, a decimal string on the wire. Null is blank: the route refuses.
  "price" numeric(38, 18) CHECK ("price" IS NULL OR "price" > 0),
  "asset_id" text CHECK ("asset_id" IS NULL OR "asset_id" ~ '^[A-Z0-9]{2,12}$'),
  -- The number of publishes written; 0 is never stored (no row means never published).
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CHECK (("price" IS NULL) = ("asset_id" IS NULL))
);

CREATE TABLE IF NOT EXISTS "token"."listing_price_moves" (
  "route" text NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "price" numeric(38, 18),
  "asset_id" text,
  "actor_id" text NOT NULL,
  "approver_id" text NOT NULL CHECK ("approver_id" <> "actor_id"),
  "at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("route", "revision")
);

-- One express request per account and token. The row is written before the fee posts (SAGA-1): `charging` holds the
-- price and asset the fee will post at, under the ledger key `fee:token:listing:<id>`; `submitted` is charged and waiting
-- for review. A retry finds the row and posts the same body again (the ledger answers the original transaction) or
-- returns the stored receipt; it never charges twice.
CREATE TABLE IF NOT EXISTS "token"."listing_requests" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "chain_id" integer NOT NULL CHECK ("chain_id" > 0),
  "token_address" text NOT NULL CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
  "route" text NOT NULL CHECK ("route" IN ('express')),
  "price" numeric(38, 18) NOT NULL CHECK ("price" > 0),
  "asset_id" text NOT NULL,
  "price_revision" integer NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('charging', 'submitted')),
  "ledger_tx_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CHECK (("status" = 'submitted') = ("ledger_tx_id" IS NOT NULL)),
  UNIQUE ("user_id", "chain_id", "token_address", "route")
);

CREATE INDEX IF NOT EXISTS "listing_requests_user_token" ON "token"."listing_requests" ("user_id", "chain_id", "token_address");

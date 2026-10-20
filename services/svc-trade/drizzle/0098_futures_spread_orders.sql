-- trade.futures_spread_orders, trade.futures_spread_fills and trade.futures_spread_fill_waits · futures calendar spread orders through svc-matching's spread book (CB-otc-16)
-- Reversal: 0098_futures_spread_orders.down.sql
--
-- A spread order is ONE order at a signed spread price over exactly two futures legs. It takes ONE ledger hold
-- (`futures.order.margin.hold:<id>`) in the quote asset both legs share. The hold is not stored as a figure: it is a
-- function of the order's terms below (quantity, leverage, and for each leg its ratio, the mark it was read at and the
-- half-width of the price band around that mark), exactly as for a matched order (0083).
--
-- WHY THE HOLD COVERS EVERY FILL. The engine prints leg 0 at the TAKER's anchor reference and leg 1 at the residual
-- that makes the spread price exact, so a resting order's legs are priced by whoever hits it. svc-trade is the only
-- caller of the spread door and chooses every anchor, and it chooses it inside the `anchor_lo .. anchor_hi` window of
-- every live order the new order can cross (checked under a per-spread lock, `spread-orders.ts`). The window is the
-- set of anchors at which neither leg of THIS order can print further against it than its band half-width, so the
-- adverse distance each leg adds to its margin is at most `leg*_delta`, which the hold already includes.
--
-- A row in trade.futures_spread_fills is an intent to post ONE leg of one spread fill for one order, written (both legs
-- together, in one transaction) before the first ledger call, under the key
-- `spread:<spreadId>:<sequence>:<leg>:<positionId>` (the ledger key is `futures.fill:` + that). A spread's sequence
-- comes from the spread book's own sequence space, so the key carries the spread id and can never equal an outright
-- fill's `<marketId>:<sequence>:<positionId>`. It turns `applied` once the position row has caught up with the post.
-- No table here is spendable. The ledger hold and the position collateral pots are the money.
CREATE TABLE IF NOT EXISTS "trade"."futures_spread_orders" (
  "id"               uuid            PRIMARY KEY,
  "user_id"          text            NOT NULL,
  "spread_id"        text            NOT NULL,
  "client_order_id"  text            NOT NULL,
  "side"             text            NOT NULL,
  "qty"              numeric(38, 18) NOT NULL,
  -- The spread price: a weighted leg-price difference, so it may be zero or negative.
  "limit_price"      numeric(38, 18) NOT NULL,
  "leverage"         numeric(8, 2)   NOT NULL,
  "hold_asset"       text            NOT NULL,
  -- Leg 0 is the anchor leg, leg 1 the residual leg (the engine's order). `*_side` is the side the spread's LISTING
  -- gives the leg for the spread buyer; the order's own side on a leg follows from `side`.
  "leg0_market_id"   uuid            NOT NULL REFERENCES "trade"."markets" ("id"),
  "leg0_side"        text            NOT NULL,
  "leg0_ratio"       numeric(38, 18) NOT NULL,
  "leg0_mark"        numeric(38, 18) NOT NULL,
  "leg0_delta"       numeric(38, 18) NOT NULL,
  "leg1_market_id"   uuid            NOT NULL REFERENCES "trade"."markets" ("id"),
  "leg1_side"        text            NOT NULL,
  "leg1_ratio"       numeric(38, 18) NOT NULL,
  "leg1_mark"        numeric(38, 18) NOT NULL,
  "leg1_delta"       numeric(38, 18) NOT NULL,
  -- The anchors at which this order's legs stay inside their bands; an order that is live in the book is only ever
  -- crossed by a taker whose anchor lies in this window.
  "anchor_lo"        numeric(38, 18) NOT NULL,
  "anchor_hi"        numeric(38, 18) NOT NULL,
  -- The anchor reference this order was sent with (its own fills as a taker print leg 0 here). NULL until it is sent.
  "anchor_ref"       numeric(38, 18),
  "filled_qty"       numeric(38, 18) NOT NULL DEFAULT 0,
  "leg0_adverse_num" numeric(78, 0)  NOT NULL DEFAULT 0,
  "leg1_adverse_num" numeric(78, 0)  NOT NULL DEFAULT 0,
  "leg0_applied"     numeric(38, 18) NOT NULL DEFAULT 0,
  "leg1_applied"     numeric(38, 18) NOT NULL DEFAULT 0,
  "applied_amount"   numeric(38, 18) NOT NULL DEFAULT 0,
  "released_amount"  numeric(38, 18) NOT NULL DEFAULT 0,
  -- What the engine says it filled in all once the order left the book (qty less the cancellation's remainingQty;
  -- 0 on a rejection). NULL while the order may still fill. The unused hold is released only when filled_qty has
  -- caught up with it, so a fill the engine printed before a cancel still settles.
  "engine_filled_qty" numeric(38, 18),
  "status"           text            NOT NULL DEFAULT 'pending',
  "refusal_code"     text,
  "created_at"       timestamptz     NOT NULL DEFAULT now(),
  "updated_at"       timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT "futures_spread_orders_client_uniq" UNIQUE ("user_id", "spread_id", "client_order_id"),
  CONSTRAINT "futures_spread_orders_side_ck" CHECK ("side" IN ('buy', 'sell')),
  CONSTRAINT "futures_spread_orders_legs_ck" CHECK (
    "leg0_market_id" <> "leg1_market_id"
    AND "leg0_side" IN ('buy', 'sell') AND "leg1_side" IN ('buy', 'sell') AND "leg0_side" <> "leg1_side"
  ),
  CONSTRAINT "futures_spread_orders_qty_ck" CHECK ("qty" > 0),
  CONSTRAINT "futures_spread_orders_leverage_ck" CHECK ("leverage" > 0),
  CONSTRAINT "futures_spread_orders_leg_terms_ck" CHECK (
    "leg0_ratio" > 0 AND "leg1_ratio" > 0 AND "leg0_mark" > 0 AND "leg1_mark" > 0
    AND "leg0_delta" >= 0 AND "leg1_delta" >= 0
    AND "leg0_delta" < "leg0_mark" AND "leg1_delta" < "leg1_mark"
  ),
  CONSTRAINT "futures_spread_orders_window_ck" CHECK (
    "anchor_lo" > 0 AND "anchor_lo" <= "anchor_hi" AND ("anchor_ref" IS NULL OR "anchor_ref" BETWEEN "anchor_lo" AND "anchor_hi")
  ),
  CONSTRAINT "futures_spread_orders_filled_ck" CHECK (
    "filled_qty" >= 0 AND "filled_qty" <= "qty" AND "leg0_adverse_num" >= 0 AND "leg1_adverse_num" >= 0
  ),
  CONSTRAINT "futures_spread_orders_engine_filled_ck" CHECK (
    "engine_filled_qty" IS NULL OR ("engine_filled_qty" >= 0 AND "engine_filled_qty" <= "qty")
  ),
  CONSTRAINT "futures_spread_orders_applied_ck" CHECK (
    "leg0_applied" >= 0 AND "leg1_applied" >= 0 AND "applied_amount" = "leg0_applied" + "leg1_applied" AND "released_amount" >= 0
  ),
  CONSTRAINT "futures_spread_orders_status_ck" CHECK (
    "status" IN ('pending', 'held', 'submitting', 'open', 'filled', 'cancelled', 'rejected', 'refused', 'submit_unknown')
  )
);

CREATE INDEX IF NOT EXISTS "futures_spread_orders_spread_status_idx"
  ON "trade"."futures_spread_orders" ("spread_id", "status");
CREATE INDEX IF NOT EXISTS "futures_spread_orders_user_status_idx"
  ON "trade"."futures_spread_orders" ("user_id", "status");

CREATE TABLE IF NOT EXISTS "trade"."futures_spread_fills" (
  "fill_key"        text            PRIMARY KEY,
  "order_id"        uuid            NOT NULL REFERENCES "trade"."futures_spread_orders" ("id"),
  "spread_id"       text            NOT NULL,
  "engine_sequence" bigint          NOT NULL,
  "leg_index"       smallint        NOT NULL,
  "market_id"       uuid            NOT NULL REFERENCES "trade"."markets" ("id"),
  "position_id"     uuid            NOT NULL,
  -- The spread quantity of the whole fill (both legs' rows carry it) and this leg's own quantity and price.
  "spread_qty"      numeric(38, 18) NOT NULL,
  "qty"             numeric(38, 18) NOT NULL,
  "price"           numeric(38, 18) NOT NULL,
  -- Margin this leg's share of the fill moves from the order's hold into the position's collateral pot.
  "amount"          numeric(38, 18) NOT NULL,
  -- The order's cumulative state after this fill: spread quantity filled, this leg's adverse numerator and need.
  "new_filled"      numeric(38, 18) NOT NULL,
  "new_adverse"     numeric(78, 0)  NOT NULL,
  "new_applied"     numeric(38, 18) NOT NULL,
  "state"           text            NOT NULL DEFAULT 'pending',
  "created_at"      timestamptz     NOT NULL DEFAULT now(),
  "applied_at"      timestamptz,
  CONSTRAINT "futures_spread_fills_leg_uniq" UNIQUE ("order_id", "engine_sequence", "leg_index"),
  CONSTRAINT "futures_spread_fills_leg_ck" CHECK ("leg_index" IN (0, 1)),
  CONSTRAINT "futures_spread_fills_qty_ck" CHECK ("spread_qty" > 0 AND "qty" > 0),
  CONSTRAINT "futures_spread_fills_price_ck" CHECK ("price" > 0),
  CONSTRAINT "futures_spread_fills_amount_ck" CHECK ("amount" >= 0 AND "new_applied" >= "amount"),
  CONSTRAINT "futures_spread_fills_state_ck" CHECK ("state" IN ('pending', 'applied')),
  CONSTRAINT "futures_spread_fills_applied_at_ck" CHECK (("state" = 'applied') = ("applied_at" IS NOT NULL))
);

-- A fill that is still being recorded holds its position: close, liquidation, funding and margin changes refuse it.
CREATE INDEX IF NOT EXISTS "futures_spread_fills_position_pending_idx"
  ON "trade"."futures_spread_fills" ("position_id") WHERE "state" = 'pending';
CREATE INDEX IF NOT EXISTS "futures_spread_fills_order_pending_idx"
  ON "trade"."futures_spread_fills" ("order_id") WHERE "state" = 'pending';

-- A spread fill that arrived while one of its positions was busy (a live liquidation rung, a planned ADL pair, a
-- review hold or a margin change in flight). Kept here and retried on the liquidation cadence until it settles, so it
-- never depends on the matching event being delivered again. A row is an intent to settle one engine fill.
CREATE TABLE IF NOT EXISTS "trade"."futures_spread_fill_waits" (
  "spread_id"       text            NOT NULL,
  "engine_sequence" bigint          NOT NULL,
  "maker_order_id"  uuid            NOT NULL,
  "taker_order_id"  uuid            NOT NULL,
  "taker_side"      text            NOT NULL,
  "price"           numeric(38, 18) NOT NULL,
  "qty"             numeric(38, 18) NOT NULL,
  "leg0_symbol"     text            NOT NULL,
  "leg0_taker_side" text            NOT NULL,
  "leg0_qty"        numeric(38, 18) NOT NULL,
  "leg0_price"      numeric(38, 18) NOT NULL,
  "leg1_symbol"     text            NOT NULL,
  "leg1_taker_side" text            NOT NULL,
  "leg1_qty"        numeric(38, 18) NOT NULL,
  "leg1_price"      numeric(38, 18) NOT NULL,
  "reason"          text            NOT NULL,
  "attempts"        integer         NOT NULL DEFAULT 1,
  "created_at"      timestamptz     NOT NULL DEFAULT now(),
  "retried_at"      timestamptz,
  "settled_at"      timestamptz,
  PRIMARY KEY ("spread_id", "engine_sequence"),
  CONSTRAINT "futures_spread_fill_waits_qty_ck" CHECK ("qty" > 0 AND "leg0_qty" > 0 AND "leg1_qty" > 0),
  CONSTRAINT "futures_spread_fill_waits_price_ck" CHECK ("leg0_price" > 0 AND "leg1_price" > 0),
  CONSTRAINT "futures_spread_fill_waits_side_ck" CHECK (
    "taker_side" IN ('buy', 'sell') AND "leg0_taker_side" IN ('buy', 'sell') AND "leg1_taker_side" IN ('buy', 'sell')
  )
);
CREATE INDEX IF NOT EXISTS "futures_spread_fill_waits_open_idx"
  ON "trade"."futures_spread_fill_waits" ("retried_at" NULLS FIRST, "created_at", "engine_sequence") WHERE "settled_at" IS NULL;

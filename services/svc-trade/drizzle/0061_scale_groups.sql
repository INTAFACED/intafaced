-- trade.scale · one ladder group for a scaled limit order (SCL-1)
-- Reversal: 0061_scale_groups.down.sql
--
-- The group is an id and the child order ids. It holds no balance. Each child
-- is an ordinary limit order placed through the existing order path. Params are
-- the caller's ladder (decimal strings), not a second book.

CREATE TABLE IF NOT EXISTS "trade"."scale_groups" (
  "id"               text PRIMARY KEY,
  "user_id"          text NOT NULL,
  "client_group_id"  text NOT NULL,
  "market_id"        uuid NOT NULL REFERENCES "trade"."markets" ("id"),
  "side"             "trade"."order_side" NOT NULL,
  "params"           jsonb NOT NULL,
  "child_order_ids"  jsonb NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "scale_groups_user_client_uq" UNIQUE ("user_id", "client_group_id")
);

CREATE INDEX IF NOT EXISTS "scale_groups_user_created_idx"
  ON "trade"."scale_groups" ("user_id", "created_at" DESC);

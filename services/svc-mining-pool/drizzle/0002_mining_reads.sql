-- svc-mining-pool · worker roster, refused-share rows, paid time.
-- Worker registration is not a writer in this migration. Rows are readable once a later
-- scope is chosen. Refusals are recorded only after HMAC, keyed by the caller's idempotency key.

ALTER TABLE "mining_pool"."windows" ADD COLUMN IF NOT EXISTS "paid_at" timestamptz;

CREATE TABLE IF NOT EXISTS "mining_pool"."workers" (
  "id"         text PRIMARY KEY,
  "user_id"    text NOT NULL,
  "name"       text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workers_id_nonblank_ck" CHECK (length(btrim("id")) > 0),
  CONSTRAINT "workers_user_nonblank_ck" CHECK (length(btrim("user_id")) > 0),
  CONSTRAINT "workers_name_nonblank_ck" CHECK (length(btrim("name")) > 0)
);

CREATE INDEX IF NOT EXISTS "workers_user_created_idx"
  ON "mining_pool"."workers" ("user_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "workers_created_idx"
  ON "mining_pool"."workers" ("created_at" DESC, "id" DESC);

CREATE TABLE IF NOT EXISTS "mining_pool"."share_rejections" (
  "idempotency_key" text PRIMARY KEY,
  "window_id"       text NOT NULL,
  "miner_id"        text NOT NULL,
  "reason_code"     text NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "share_rejections_key_len_ck" CHECK (length(btrim("idempotency_key")) >= 8 AND length("idempotency_key") <= 200),
  CONSTRAINT "share_rejections_window_nonblank_ck" CHECK (length(btrim("window_id")) > 0),
  CONSTRAINT "share_rejections_miner_nonblank_ck" CHECK (length(btrim("miner_id")) > 0),
  CONSTRAINT "share_rejections_reason_nonblank_ck" CHECK (length(btrim("reason_code")) > 0)
);

CREATE INDEX IF NOT EXISTS "share_rejections_window_idx"
  ON "mining_pool"."share_rejections" ("window_id", "created_at");

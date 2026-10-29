-- svc-mining-pool · the proof-of-work nonce a checked share carried, and pooled or solo per worker.
-- One nonce counts once per window and worker: the same work under a new share id is a duplicate. A solo worker's
-- shares are stored with solo = true and kept out of the pooled (PPLNS) split; a worker changes mode only while it has
-- no share in an open window.

ALTER TABLE "mining_pool"."shares" ADD COLUMN IF NOT EXISTS "pow_nonce" text;
ALTER TABLE "mining_pool"."shares" ADD COLUMN IF NOT EXISTS "solo" boolean NOT NULL DEFAULT false;
-- Work checked under a testnet proof-of-work set, stamped when it is stored: a window holding any of it earns no credit,
-- whatever the settings say later.
ALTER TABLE "mining_pool"."shares" ADD COLUMN IF NOT EXISTS "testnet" boolean NOT NULL DEFAULT false;
-- A window of testnet work is closed with no credit ('no_credit'): it never pays, and its rigs may change mode again.
ALTER TABLE "mining_pool"."windows" DROP CONSTRAINT IF EXISTS "windows_status_ck";
ALTER TABLE "mining_pool"."windows" ADD CONSTRAINT "windows_status_ck" CHECK ("status" IN ('open', 'paid', 'no_credit'));
CREATE UNIQUE INDEX IF NOT EXISTS "shares_window_worker_nonce_uidx"
  ON "mining_pool"."shares" ("window_id", "worker_id", "pow_nonce")
  WHERE "pow_nonce" IS NOT NULL;

ALTER TABLE "mining_pool"."workers" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'pooled';
ALTER TABLE "mining_pool"."workers" DROP CONSTRAINT IF EXISTS "workers_mode_ck";
ALTER TABLE "mining_pool"."workers" ADD CONSTRAINT "workers_mode_ck" CHECK ("mode" IN ('pooled', 'solo'));

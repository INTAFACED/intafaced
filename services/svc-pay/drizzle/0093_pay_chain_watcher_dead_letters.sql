-- DEAD LETTERS FOR THE INBOUND CHAIN WATCHER.
--
-- An inbound the watcher could not deliver to the book after the owner-published number of attempts is recorded
-- here and released, so it no longer holds up the address behind it. A person decides what happens next.
-- Not money: one row per delivery id, never updated.

CREATE TABLE IF NOT EXISTS "pay"."chain_watcher_dead_letters" (
  "delivery_id" text PRIMARY KEY NOT NULL,
  "watcher_id" text NOT NULL,
  "address" text NOT NULL,
  "tx_hash" text NOT NULL,
  "log_index" integer NOT NULL,
  "block_number" text NOT NULL,
  "attempts" integer NOT NULL CHECK ("attempts" >= 1),
  "last_status" integer,
  "last_error" text,
  "dead_lettered_at" timestamptz NOT NULL DEFAULT now()
);

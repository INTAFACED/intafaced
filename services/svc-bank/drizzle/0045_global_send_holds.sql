-- intafaced:destructive drops only the status check this migration re-adds (idempotent re-run); no data is removed
-- Compliance holds, proof of payment and reference linking on a global send (BK-xfer-07).
--
-- A send can be held while it is still `submitted` and before any value has moved (`ledger_tx_id` is null), so no value is
-- reserved and no hold recipe is needed. A hold carries the reason (internal, never shown to the customer), who held it, the
-- request the customer sees, and at most one proof file by hash. Release by the person who held it is refused in the service.
--
-- Reversal: 0045_global_send_holds.down.sql

ALTER TABLE "bank"."global_sends" DROP CONSTRAINT IF EXISTS "global_sends_status_ck";
ALTER TABLE "bank"."global_sends" ADD CONSTRAINT "global_sends_status_ck"
  CHECK ("status" IN ('submitted', 'held', 'sent', 'on_the_way', 'arrived', 'failed'));

CREATE TABLE IF NOT EXISTS "bank"."global_send_holds" (
  "id" uuid PRIMARY KEY,
  "send_id" uuid NOT NULL REFERENCES "bank"."global_sends" ("id"),
  "hold_key" text NOT NULL,
  "reason" text NOT NULL,
  "placed_by" text NOT NULL,
  "state" text NOT NULL,
  "info_request" text,
  "proof_name" text,
  "proof_type" text,
  "proof_size" integer,
  "proof_sha256" text,
  "proof_bytes" bytea,
  "proof_uploaded_at" timestamptz,
  "released_by" text,
  "released_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "global_send_holds_key_uq" UNIQUE ("hold_key"),
  CONSTRAINT "global_send_holds_state_ck" CHECK ("state" IN ('requested', 'under_review', 'released')),
  CONSTRAINT "global_send_holds_reason_ck" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "global_send_holds_info_ck" CHECK ("info_request" IS NULL OR char_length("info_request") BETWEEN 1 AND 1000),
  CONSTRAINT "global_send_holds_proof_ck" CHECK (
    ("proof_sha256" IS NULL AND "proof_bytes" IS NULL AND "proof_uploaded_at" IS NULL)
    OR ("proof_sha256" ~ '^[0-9a-f]{64}$' AND "proof_bytes" IS NOT NULL AND "proof_uploaded_at" IS NOT NULL)
  ),
  CONSTRAINT "global_send_holds_released_ck" CHECK (("state" = 'released') = ("released_by" IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "global_send_holds_open_uq"
  ON "bank"."global_send_holds" ("send_id") WHERE "state" <> 'released';
CREATE INDEX IF NOT EXISTS "global_send_holds_queue_idx"
  ON "bank"."global_send_holds" ("created_at" DESC, "id" DESC) WHERE "state" <> 'released';

CREATE TABLE IF NOT EXISTS "bank"."global_incoming_links" (
  "id" uuid PRIMARY KEY,
  "reference" text NOT NULL,
  "send_id" uuid NOT NULL REFERENCES "bank"."global_sends" ("id"),
  "linked_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "global_incoming_links_reference_uq" UNIQUE ("reference")
);

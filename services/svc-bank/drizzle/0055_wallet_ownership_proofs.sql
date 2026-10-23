-- W-withdraw-17: a customer proves they control a saved private-wallet address by signing a message (J-wallet-04 #6).
--
-- One row per proof. `start` writes it `pending` with the exact message to sign and when that offer lapses (the
-- owner's proof window). `verify` checks the signature recovers the saved address and marks it `verified`, with the
-- signature and how long the proof holds (the owner's validity). A lapsed offer or a lapsed proof is read as expired;
-- nothing rewrites the row to say so. The address is copied from the entry when the proof starts, so a later change of
-- the entry never inherits a proof made for another address.
--
-- Reversal: 0055_wallet_ownership_proofs.down.sql

CREATE TABLE IF NOT EXISTS "bank"."wallet_ownership_proofs" (
  "id" uuid PRIMARY KEY,
  -- The order offers were made in: newest first, with no tie between two made in the same instant.
  "seq" bigint GENERATED ALWAYS AS IDENTITY,
  "user_id" text NOT NULL,
  "destination_id" uuid NOT NULL,
  "address" text NOT NULL,
  "message" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "verified_at" timestamptz,
  "valid_until" timestamptz,
  "signature" text,
  CONSTRAINT "wallet_ownership_proofs_status_ck" CHECK ("status" IN ('pending', 'verified')),
  CONSTRAINT "wallet_ownership_proofs_verified_ck" CHECK (
    ("status" = 'verified') = ("verified_at" IS NOT NULL AND "valid_until" IS NOT NULL AND "signature" IS NOT NULL)
  ),
  CONSTRAINT "wallet_ownership_proofs_window_ck" CHECK ("expires_at" > "created_at")
);

CREATE INDEX IF NOT EXISTS "wallet_ownership_proofs_entry_idx"
  ON "bank"."wallet_ownership_proofs" ("user_id", "destination_id", "status", "seq" DESC);

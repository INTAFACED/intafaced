-- svc-protocol · contract ownership proofs (D-launch-listing-01)
-- Reversal: 20261029070000_protocol_listing_ownership.down.sql
--
-- A challenge is a one-time message the token owner signs: a random nonce, the token, the chain and an expiry. A proof
-- records that the token's owner, read from the chain at a block, signed that exact message. One proof per nonce, so a
-- replayed challenge cannot back a second proof. No balance and no money.

CREATE TABLE IF NOT EXISTS "protocol"."listing_challenges" (
  "nonce"      text PRIMARY KEY,
  "chain_id"   integer NOT NULL,
  -- Checksummed token contract address.
  "token"      text NOT NULL,
  -- The exact message to sign.
  "message"    text NOT NULL,
  "issued_at"  timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  -- Set once, when a proof is stored against this nonce.
  "used_at"    timestamptz
);

CREATE TABLE IF NOT EXISTS "protocol"."listing_ownership_proofs" (
  "nonce"        text PRIMARY KEY REFERENCES "protocol"."listing_challenges" ("nonce"),
  "chain_id"     integer NOT NULL,
  "token"        text NOT NULL,
  -- The owner that signed: an EOA, or a contract owner that accepted the signature through ERC-1271.
  "signer"       text NOT NULL,
  "message_hash" text NOT NULL,
  "signature"    text NOT NULL,
  -- The block the owner was read at.
  "block_number" numeric(78, 0) NOT NULL,
  "verified_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "listing_ownership_proofs_token_idx" ON "protocol"."listing_ownership_proofs" ("chain_id", "token");

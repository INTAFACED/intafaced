-- svc-protocol · the venue wallet connection (J-wallet-09)
-- Reversal: 20261108194447_protocol_venue_wallet_connections.down.sql
--
-- A signed-in person's own wallet, connected to their account by the wallet's EIP-4361 signature, so a venue account the
-- wallet owns can be funded and traded from it. A row is an address and its expiry. There is no key column on purpose:
-- INTAFACED holds no key that can move the wallet's funds, and every venue action is signed in the wallet. No balance and
-- no money: the venue is the record of what the wallet holds there, and the ledger posts nothing.

CREATE TABLE IF NOT EXISTS "protocol"."venue_wallet_connections" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The signed-in INTAFACED person the wallet is connected to.
  "user_id"      text NOT NULL,
  "chain_id"     integer NOT NULL,
  -- Checksummed EVM address of the person's own wallet.
  "address"      text NOT NULL,
  "connected_at" timestamptz NOT NULL,
  -- The expiry the signed message states. After it every signed action refuses until the wallet signs again.
  "expires_at"   timestamptz NOT NULL,
  -- Set when the person disconnects; a later signature connects the wallet again.
  "revoked_at"   timestamptz,
  -- The challenge nonce of the signature that made the current connection (its business key).
  "nonce"        text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "venue_wallet_connections_address_shape_ck" CHECK ("address" ~ '^0x[0-9a-fA-F]{40}$'),
  CONSTRAINT "venue_wallet_connections_expiry_ck" CHECK ("expires_at" > "connected_at")
);
-- One connection per person, chain and wallet: connecting again renews the same row.
CREATE UNIQUE INDEX IF NOT EXISTS "venue_wallet_connections_owner_idx"
  ON "protocol"."venue_wallet_connections" ("user_id", "chain_id", lower("address"));

-- Every challenge nonce that has made a connection, so a signed message opens one connection once and never again.
CREATE TABLE IF NOT EXISTS "protocol"."venue_wallet_nonces" (
  -- The business key: venue-connect:<chainId>:<nonce>.
  "idempotency_key" text PRIMARY KEY,
  "user_id"         text NOT NULL,
  "address"         text NOT NULL,
  "used_at"         timestamptz NOT NULL DEFAULT now()
);

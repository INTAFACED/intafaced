-- svc-protocol · the embedded login's key export, once (RC-dex-protocol-05)
-- Reversal: 20261107093603_protocol_embedded_exports.down.sql
--
-- One row per account whose embedded key was shown to its owner: the fact and its time, and the key's own signature
-- saying so. Never the key. The business key is embedded.export:<chainId>:<account>.

CREATE TABLE IF NOT EXISTS "protocol"."embedded_exports" (
  "chain_id"    integer NOT NULL,
  -- Checksummed EVM address of the embedded key's account.
  "account"     text NOT NULL,
  "signature"   text NOT NULL,
  "exported_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("chain_id", "account"),
  CONSTRAINT "embedded_exports_account_shape_ck" CHECK ("account" ~ '^0x[0-9a-fA-F]{40}$')
);

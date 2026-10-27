-- svc-protocol · first-signing representations (D-developer-compliance-03)
-- Reversal: 20261024070458_protocol_signing_representations.down.sql
--
-- One row per wallet address, chain and representation version: the wallet signed the representation text of that
-- version, and this is when the service recorded it. A consent record, not a screening. No balance and no money.

CREATE TABLE IF NOT EXISTS "protocol"."signing_representations" (
  "chain_id"    integer NOT NULL,
  -- Checksummed EVM address that signed.
  "address"     text NOT NULL,
  "version"     text NOT NULL,
  -- The exact message the wallet signed, and its signature, so the record proves itself.
  "message"     text NOT NULL,
  "signature"   text NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("chain_id", "address", "version")
);

-- svc-protocol · the token blocklist (D-launch-listing-02; J-dex-protocol-30 #6)
-- Reversal: 20261122090000_protocol_token_blocklist.down.sql
--
-- A blocked token is not routed: every route, path and swap call that names it refuses `protocol.token_blocked`, and its
-- pages show the badge. One row per token on a chain (the business key); who added it, when and why. No balance, no money.

CREATE TABLE IF NOT EXISTS "protocol"."token_blocklist" (
  "chain_id"  integer NOT NULL,
  "token"     text NOT NULL,
  "reason"    text NOT NULL,
  "added_by"  text NOT NULL,
  "added_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("chain_id", "token"),
  CONSTRAINT "token_blocklist_token_ck" CHECK ("token" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "token_blocklist_reason_ck" CHECK (char_length("reason") BETWEEN 1 AND 500)
);

-- svc-protocol · public name tags (D-launch-listing-01; J-dex-protocol-30 #7)
-- Reversal: 20261114150000_protocol_name_tags.down.sql
--
-- A name tag says who an address belongs to. It is public only with an ownership proof on file (the address's on-chain
-- owner signed a one-time challenge, protocol.listing_ownership_proofs) and after two different people approved it. Then it
-- is the address's `name` label. No balance, no money, no key.

CREATE TABLE IF NOT EXISTS "protocol"."name_tag_requests" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "chain_id"           integer NOT NULL,
  -- Lowercase EVM address the tag is about.
  "address"            text NOT NULL,
  "tag"                text NOT NULL,
  "reason"             text NOT NULL,
  "status"             text NOT NULL DEFAULT 'pending',
  "requester_id"       text NOT NULL,
  -- The ownership proof the tag was published on.
  "proof_nonce"        text REFERENCES "protocol"."listing_ownership_proofs" ("nonce"),
  "first_approver_id"  text,
  "first_approved_at"  timestamptz,
  "second_approver_id" text,
  "published_at"       timestamptz,
  "asked_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "name_tag_requests_address_ck" CHECK ("address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "name_tag_requests_tag_ck" CHECK (char_length("tag") BETWEEN 1 AND 60),
  CONSTRAINT "name_tag_requests_reason_ck" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "name_tag_requests_status_ck" CHECK ("status" IN ('pending', 'public')),
  -- Two approvers, never the same person twice.
  CONSTRAINT "name_tag_requests_four_eyes_ck" CHECK ("second_approver_id" IS NULL OR "second_approver_id" <> "first_approver_id"),
  CONSTRAINT "name_tag_requests_order_ck" CHECK ("second_approver_id" IS NULL OR "first_approver_id" IS NOT NULL),
  -- Public only with two approvers and a proof, whatever the service does.
  CONSTRAINT "name_tag_requests_public_ck" CHECK (("status" = 'public') = (
    "second_approver_id" IS NOT NULL AND "proof_nonce" IS NOT NULL AND "published_at" IS NOT NULL))
);
-- The business key: one pending tag per address on a chain.
CREATE UNIQUE INDEX IF NOT EXISTS "name_tag_requests_pending_idx" ON "protocol"."name_tag_requests" ("chain_id", "address") WHERE "status" = 'pending';

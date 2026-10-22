-- svc-protocol · founding badge stuck-mint clears (RC-more-catalogue-04 review)
-- Reversal: 0002_protocol_founding_badge_mint_clears.down.sql
--
-- Audit trail for the operator clear of a mint slot stuck after a crash mid-mint. One row per clear, written in the
-- same transaction as the clear. No balance and no money.

CREATE TABLE IF NOT EXISTS "protocol"."founding_badge_mint_clears" (
  "id"            bigserial PRIMARY KEY,
  "key"           text NOT NULL,
  -- 'minted' (tx_hash is the chain evidence) or 'not_minted' (attested_by + checked_at are).
  "evidence_kind" text NOT NULL CHECK ("evidence_kind" IN ('minted', 'not_minted')),
  "tx_hash"       text,
  "attested_by"   text,
  "checked_at"    timestamptz,
  "reason"        text NOT NULL,
  -- Operator principal that called the clear, the approval's proposer and its distinct approver (svc-identity).
  "actor_id"      text NOT NULL,
  "requester_id"  text NOT NULL,
  "approver_id"   text NOT NULL,
  "approval_id"   text NOT NULL UNIQUE,
  "cleared_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "founding_badge_mint_clears_key_idx" ON "protocol"."founding_badge_mint_clears" ("key");

-- svc-protocol · listing overrides for the Protocol ops desk (D-order-controls-04)
-- Reversal: 0001_listing_overrides.down.sql
--
-- A hide or delist is a LISTING decision, not an on-chain pause: pools have no admin and no pause by design. These
-- tables say which pool or market INTAFACED does not list, who signed it and under which policy. They hold no balance
-- and no key, and nothing here can move or freeze anyone's funds.

CREATE TABLE IF NOT EXISTS "protocol"."listing_overrides" (
  "kind"          text NOT NULL,
  "target_id"     text NOT NULL,
  "state"         text NOT NULL,
  "reason_code"   text,
  "reason"        text,
  "approval_id"   text NOT NULL,
  "policy_version" text NOT NULL,
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("kind", "target_id"),
  CONSTRAINT "listing_overrides_kind_ck" CHECK ("kind" IN ('pool', 'market')),
  CONSTRAINT "listing_overrides_state_ck" CHECK ("state" IN ('hidden', 'visible', 'applying'))
);

-- Append-only. The key is `<action>:<targetId>:<approvalId>`, so a retry with the same approval returns the stored result.
CREATE TABLE IF NOT EXISTS "protocol"."listing_decisions" (
  "idempotency_key" text PRIMARY KEY,
  "action"          text NOT NULL,
  "kind"            text NOT NULL,
  "target_id"       text NOT NULL,
  "outcome"         text NOT NULL,
  "note"            text,
  "reason_code"     text,
  "reason"          text,
  "approval_id"     text NOT NULL,
  "requester_id"    text NOT NULL,
  "approver_id"     text NOT NULL,
  "policy_version"  text NOT NULL,
  "decided_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "listing_decisions_outcome_ck" CHECK ("outcome" IN ('applied', 'noop'))
);
CREATE INDEX IF NOT EXISTS "listing_decisions_target_idx" ON "protocol"."listing_decisions" ("kind", "target_id", "decided_at");

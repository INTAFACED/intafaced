-- svc-protocol · token tiers and permissioned pool onboarding (D-launch-listing-02, D-liquidity-07; J-dex-protocol-30 #4 #9)
-- Reversal: 20261113040000_protocol_trust_desk.down.sql
--
-- A human tier is asked by one person and approved by a different one; only then is it in force, with its date and
-- reason. Removing it returns the token to the tier before it. Every ask, approval and removal is an audit row. An
-- onboarding checklist with a blank item cannot be approved, and its opener cannot approve it. No balance, no money, no key.

CREATE TABLE IF NOT EXISTS "protocol"."token_tier_requests" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "chain_id"     integer NOT NULL,
  "token"        text NOT NULL,
  "tier"         text NOT NULL,
  "reason"       text NOT NULL,
  "status"       text NOT NULL DEFAULT 'pending',
  "requester_id" text NOT NULL,
  "approver_id"  text,
  "asked_at"     timestamptz NOT NULL DEFAULT now(),
  "decided_at"   timestamptz,
  CONSTRAINT "token_tier_requests_tier_ck" CHECK ("tier" IN ('verified', 'unverified', 'banned')),
  CONSTRAINT "token_tier_requests_status_ck" CHECK ("status" IN ('pending', 'approved')),
  CONSTRAINT "token_tier_requests_reason_ck" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "token_tier_requests_token_ck" CHECK ("token" ~ '^0x[0-9a-f]{40}$'),
  -- Four eyes: the approver is never the person who asked.
  CONSTRAINT "token_tier_requests_four_eyes_ck" CHECK ("approver_id" IS NULL OR "approver_id" <> "requester_id"),
  CONSTRAINT "token_tier_requests_decided_ck" CHECK (("status" = 'pending') = ("approver_id" IS NULL AND "decided_at" IS NULL))
);
-- The business key: one pending tier change per token.
CREATE UNIQUE INDEX IF NOT EXISTS "token_tier_requests_pending_idx" ON "protocol"."token_tier_requests" ("chain_id", "token") WHERE "status" = 'pending';

-- The human tier in force per token, and the one a removal returns to.
CREATE TABLE IF NOT EXISTS "protocol"."token_tiers" (
  "chain_id"     integer NOT NULL,
  "token"        text NOT NULL,
  "tier"         text NOT NULL,
  "prior_tier"   text,
  "reason"       text NOT NULL,
  "request_id"   uuid NOT NULL REFERENCES "protocol"."token_tier_requests" ("id"),
  "since"        timestamptz NOT NULL,
  PRIMARY KEY ("chain_id", "token"),
  CONSTRAINT "token_tiers_tier_ck" CHECK ("tier" IN ('verified', 'unverified', 'banned')),
  CONSTRAINT "token_tiers_prior_ck" CHECK ("prior_tier" IS NULL OR "prior_tier" IN ('verified', 'unverified', 'banned'))
);

CREATE TABLE IF NOT EXISTS "protocol"."token_tier_audit" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "chain_id"    integer NOT NULL,
  "token"       text NOT NULL,
  "action"      text NOT NULL,
  "tier"        text NOT NULL,
  "returned_to" text,
  "reason"      text NOT NULL,
  "actor_id"    text NOT NULL,
  "at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "token_tier_audit_action_ck" CHECK ("action" IN ('asked', 'approved', 'removed'))
);
CREATE INDEX IF NOT EXISTS "token_tier_audit_token_idx" ON "protocol"."token_tier_audit" ("chain_id", "token", "at");

CREATE TABLE IF NOT EXISTS "protocol"."pool_onboarding" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "chain_id"             integer NOT NULL,
  "pool"                 text NOT NULL,
  "legal_entity"         text,
  "token_contract"       text,
  "checker_address"      text,
  "wrapper_address"      text,
  "routing_registration" text,
  "status"               text NOT NULL DEFAULT 'open',
  "opened_by"            text NOT NULL,
  "approved_by"          text,
  "approval_reason"      text,
  "opened_at"            timestamptz NOT NULL DEFAULT now(),
  "approved_at"          timestamptz,
  CONSTRAINT "pool_onboarding_status_ck" CHECK ("status" IN ('open', 'approved')),
  CONSTRAINT "pool_onboarding_four_eyes_ck" CHECK ("approved_by" IS NULL OR "approved_by" <> "opened_by"),
  -- A checklist with a blank item is never approved, whatever the service does.
  CONSTRAINT "pool_onboarding_complete_ck" CHECK ("status" = 'open' OR (
    "legal_entity" IS NOT NULL AND "token_contract" IS NOT NULL AND "checker_address" IS NOT NULL
    AND "wrapper_address" IS NOT NULL AND "routing_registration" IS NOT NULL AND "approved_by" IS NOT NULL
    AND "approval_reason" IS NOT NULL AND "approved_at" IS NOT NULL))
);
-- The business key: one checklist per pool name on a chain.
CREATE UNIQUE INDEX IF NOT EXISTS "pool_onboarding_pool_idx" ON "protocol"."pool_onboarding" ("chain_id", lower("pool"));

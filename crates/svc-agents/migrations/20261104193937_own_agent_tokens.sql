-- svc-agents · each own agent's identity: a token of its own, with an owner, scopes and an expiry (AG-identity-01; J-agents-03 #5)
-- Reversal: 20261104193937_own_agent_tokens.down.sql
--
-- Only a hash of the token is kept; the token itself is shown once, when it is issued. One token per agent is live at a
-- time: issuing another revokes the one before. A call made with a token is refused once it is revoked or expired, or
-- while its owner's account is frozen (read from identity per call, never copied here). Nothing here moves value.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_tokens" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"    uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"    text NOT NULL,
  "token_hash"  text NOT NULL,
  "scopes"      jsonb NOT NULL,
  "issued_at"   timestamptz NOT NULL DEFAULT now(),
  "expires_at"  timestamptz NOT NULL,
  "revoked_at"  timestamptz,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_tokens_hash_uq" UNIQUE ("token_hash"),
  CONSTRAINT "own_agent_tokens_scopes_ck" CHECK (jsonb_typeof("scopes") = 'array'),
  CONSTRAINT "own_agent_tokens_expiry_ck" CHECK ("expires_at" > "issued_at")
);

-- At most one live (unrevoked) token per agent.
CREATE UNIQUE INDEX IF NOT EXISTS "own_agent_tokens_live_uq" ON "agents"."own_agent_tokens" ("agent_id") WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "own_agent_tokens_owner_idx" ON "agents"."own_agent_tokens" ("owner_id", "agent_id", "issued_at" DESC);

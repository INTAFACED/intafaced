-- svc-agents · the Navigator's on-chain session key bindings and its trade approval requests (RC-agents-01,
-- AG-approvals-01; J-agents-19)
-- Reversal: 20261110022953_navigator_onchain.down.sql
--
-- A binding is what the person prepared for the Navigator's session key on their smart account: the scope, the cap in
-- wei, the expiry and the scope's hash, keyed agents:onchain:navigator:<chain>:<account>:<session key>, and whether they
-- asked to revoke it. It is never a claim about the chain: whether the key is granted, live, spent or revoked is read
-- from the chain. The person signs the grant and the revoke in their own wallet; no value moves through INTAFACED.
--
-- An approval request is a trade the person asked the Navigator for, keyed agents:approve:<session>:<request id>. The
-- Navigator never trades unasked and a session key is a ceiling, not consent: the request waits for the person until
-- its expiry and nothing runs. Nothing here is a balance.

CREATE TABLE IF NOT EXISTS "agents"."navigator_onchain_bindings" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"              text NOT NULL,
  "chain_id"             integer NOT NULL,
  "account"              text NOT NULL,
  "session_key"          text NOT NULL,
  -- Wei, exact. Never a float.
  "spend_limit_wei"      numeric(78, 0) NOT NULL,
  "valid_until"          bigint NOT NULL,
  "targets"              text[] NOT NULL,
  "selectors"            text[] NOT NULL,
  "spec_hash"            text NOT NULL,
  "bind_key"             text NOT NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  "revoke_requested_at"  timestamptz,
  CONSTRAINT "navigator_onchain_bindings_cap_ck" CHECK ("spend_limit_wei" >= 0),
  CONSTRAINT "navigator_onchain_bindings_scope_ck" CHECK (cardinality("targets") > 0 AND cardinality("selectors") > 0),
  CONSTRAINT "navigator_onchain_bindings_key_uq" UNIQUE ("user_id", "bind_key")
);
CREATE INDEX IF NOT EXISTS "navigator_onchain_bindings_user_idx" ON "agents"."navigator_onchain_bindings" ("user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "agents"."navigator_approval_requests" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      text NOT NULL,
  "session_id"   uuid NOT NULL REFERENCES "agents"."agent_sessions" ("id"),
  "request_key"  text NOT NULL,
  "tool"         text NOT NULL,
  -- The ask the person must decide on, shown back to them only.
  "ask_text"     text NOT NULL,
  "status"       text NOT NULL DEFAULT 'waiting',
  "expires_at"   timestamptz NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "navigator_approval_requests_tool_ck" CHECK ("tool" = 'trade'),
  CONSTRAINT "navigator_approval_requests_status_ck" CHECK ("status" = 'waiting'),
  CONSTRAINT "navigator_approval_requests_key_uq" UNIQUE ("user_id", "request_key")
);
CREATE INDEX IF NOT EXISTS "navigator_approval_requests_session_idx"
  ON "agents"."navigator_approval_requests" ("user_id", "session_id", "created_at" DESC);

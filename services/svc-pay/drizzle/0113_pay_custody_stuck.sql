-- Per-vault queue, stuck transaction handling and reverse after a dropped transaction (W-custody-ops-12). NOTHING HERE
-- HOLDS A BALANCE: the ledger is the only book, and a reverse is posted through the withdrawal recipe, never from here.
-- Everything is append-only. A link ties a withdrawal to the custody wallet and nonce it was signed with. A boost,
-- replace or drop is an ACTION written before the chain port is asked, keyed by the caller's business key; its outcomes
-- are separate rows, so the original transaction counts as replaced or dropped only when an outcome row says the chain
-- showed it. A reverse needs the evidence of a dropped transaction (hash and nonce), a reason and a second approver.
CREATE TABLE IF NOT EXISTS "pay"."custody_tx_wallet_links" (
  "withdrawal_id" uuid NOT NULL REFERENCES "pay"."withdrawals" ("id"),
  -- A customer retry opens a new attempt with a new send, so a link belongs to one attempt.
  "attempt" integer NOT NULL,
  "wallet_id" uuid NOT NULL REFERENCES "pay"."custody_wallets" ("wallet_id"),
  "nonce" bigint,
  "linked_by" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_tx_wallet_links_pk" PRIMARY KEY ("withdrawal_id", "attempt"),
  CONSTRAINT "custody_tx_wallet_links_nonce_ck" CHECK ("attempt" >= 0 AND ("nonce" IS NULL OR "nonce" >= 0)),
  CONSTRAINT "custody_tx_wallet_links_by_ck" CHECK (length(btrim("linked_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "custody_tx_wallet_links_wallet_idx" ON "pay"."custody_tx_wallet_links" ("wallet_id", "nonce");

-- How long a transaction may be in flight before it is stuck, per network. No row means blank and diagnosis refuses.
CREATE TABLE IF NOT EXISTS "pay"."custody_stuck_threshold_events" (
  "seq" bigserial PRIMARY KEY,
  "network_id" text NOT NULL,
  "seconds" integer NOT NULL,
  "reason" text NOT NULL,
  "set_by" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_stuck_threshold_seconds_ck" CHECK ("seconds" > 0),
  CONSTRAINT "custody_stuck_threshold_text_ck" CHECK (length(btrim("network_id")) > 0 AND length(btrim("reason")) > 0 AND length(btrim("set_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "custody_stuck_threshold_network_idx" ON "pay"."custody_stuck_threshold_events" ("network_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."custody_tx_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "action_key" text NOT NULL,
  "kind" text NOT NULL,
  "withdrawal_id" uuid NOT NULL REFERENCES "pay"."withdrawals" ("id"),
  -- The withdrawal's attempt number when the action was taken: a customer retry opens a new attempt with a new hold.
  "withdrawal_attempt" integer NOT NULL,
  "original_tx_hash" text NOT NULL,
  "nonce" bigint NOT NULL,
  "max_fee" numeric(38,18),
  "max_fee_unit" text,
  "reason" text NOT NULL,
  "requested_by" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_tx_actions_kind_ck" CHECK ("kind" IN ('boost', 'replace', 'drop')),
  CONSTRAINT "custody_tx_actions_nonce_ck" CHECK ("nonce" >= 0 AND "withdrawal_attempt" >= 0),
  CONSTRAINT "custody_tx_actions_fee_ck" CHECK (("max_fee" IS NULL) = ("max_fee_unit" IS NULL) AND ("max_fee" IS NULL OR "max_fee" > 0)),
  CONSTRAINT "custody_tx_actions_text_ck" CHECK (length(btrim("action_key")) > 0 AND length(btrim("original_tx_hash")) > 0
    AND length(btrim("reason")) > 0 AND length(btrim("requested_by")) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "custody_tx_actions_key_uq" ON "pay"."custody_tx_actions" ("action_key");
CREATE INDEX IF NOT EXISTS "custody_tx_actions_withdrawal_idx" ON "pay"."custody_tx_actions" ("withdrawal_id", "at");

CREATE TABLE IF NOT EXISTS "pay"."custody_tx_action_outcomes" (
  "seq" bigserial PRIMARY KEY,
  "action_id" uuid NOT NULL REFERENCES "pay"."custody_tx_actions" ("id"),
  "outcome" text NOT NULL,
  "tx_hash" text,
  "failure_code" text,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_tx_action_outcome_ck" CHECK ("outcome" IN ('submitted', 'failed', 'replaced', 'dropped', 'original_mined')),
  CONSTRAINT "custody_tx_action_outcome_hash_ck" CHECK (
    ("outcome" IN ('submitted', 'replaced') AND "tx_hash" IS NOT NULL) OR ("outcome" NOT IN ('submitted', 'replaced'))
  ),
  CONSTRAINT "custody_tx_action_outcome_failure_ck" CHECK (("outcome" = 'failed') = ("failure_code" IS NOT NULL)),
  CONSTRAINT "custody_tx_action_outcome_uq" UNIQUE ("action_id", "outcome")
);

CREATE TABLE IF NOT EXISTS "pay"."custody_reverse_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "withdrawal_id" uuid NOT NULL REFERENCES "pay"."withdrawals" ("id"),
  "action_id" uuid NOT NULL REFERENCES "pay"."custody_tx_actions" ("id"),
  -- The attempt the evidence is about. The ledger reverse refuses any other attempt.
  "attempt" integer NOT NULL,
  "evidence_tx_hash" text NOT NULL,
  "evidence_nonce" bigint NOT NULL,
  "reason" text NOT NULL,
  "requested_by" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_reverse_nonce_ck" CHECK ("evidence_nonce" >= 0),
  CONSTRAINT "custody_reverse_text_ck" CHECK (length(btrim("evidence_tx_hash")) > 0 AND length(btrim("reason")) > 0 AND length(btrim("requested_by")) > 0)
);
-- One reverse request per withdrawal attempt: a second ask for the same attempt is the same ask.
CREATE UNIQUE INDEX IF NOT EXISTS "custody_reverse_withdrawal_attempt_uq" ON "pay"."custody_reverse_requests" ("withdrawal_id", "attempt");

CREATE TABLE IF NOT EXISTS "pay"."custody_reverse_approvals" (
  "seq" bigserial PRIMARY KEY,
  "request_id" uuid NOT NULL REFERENCES "pay"."custody_reverse_requests" ("id"),
  "approver" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_reverse_approver_ck" CHECK (length(btrim("approver")) > 0),
  CONSTRAINT "custody_reverse_approval_uq" UNIQUE ("request_id", "approver")
);

-- The ledger posting is keyed by the withdrawal's own attempt key, so this row only records that it was posted.
CREATE TABLE IF NOT EXISTS "pay"."custody_reverse_outcomes" (
  "request_id" uuid PRIMARY KEY REFERENCES "pay"."custody_reverse_requests" ("id"),
  "executed_by" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_reverse_outcome_by_ck" CHECK (length(btrim("executed_by")) > 0)
);

CREATE OR REPLACE FUNCTION "pay"."custody_stuck_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on pay.% is not permitted: links, thresholds, stuck-transaction actions, their outcomes and reverse requests are never edited or deleted.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "custody_tx_wallet_links_append_only_trg" ON "pay"."custody_tx_wallet_links";
CREATE TRIGGER "custody_tx_wallet_links_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_tx_wallet_links"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_stuck_append_only"();
DROP TRIGGER IF EXISTS "custody_stuck_threshold_append_only_trg" ON "pay"."custody_stuck_threshold_events";
CREATE TRIGGER "custody_stuck_threshold_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_stuck_threshold_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_stuck_append_only"();
DROP TRIGGER IF EXISTS "custody_tx_actions_append_only_trg" ON "pay"."custody_tx_actions";
CREATE TRIGGER "custody_tx_actions_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_tx_actions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_stuck_append_only"();
DROP TRIGGER IF EXISTS "custody_tx_action_outcomes_append_only_trg" ON "pay"."custody_tx_action_outcomes";
CREATE TRIGGER "custody_tx_action_outcomes_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_tx_action_outcomes"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_stuck_append_only"();
DROP TRIGGER IF EXISTS "custody_reverse_requests_append_only_trg" ON "pay"."custody_reverse_requests";
CREATE TRIGGER "custody_reverse_requests_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_reverse_requests"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_stuck_append_only"();
DROP TRIGGER IF EXISTS "custody_reverse_approvals_append_only_trg" ON "pay"."custody_reverse_approvals";
CREATE TRIGGER "custody_reverse_approvals_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_reverse_approvals"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_stuck_append_only"();
DROP TRIGGER IF EXISTS "custody_reverse_outcomes_append_only_trg" ON "pay"."custody_reverse_outcomes";
CREATE TRIGGER "custody_reverse_outcomes_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_reverse_outcomes"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_stuck_append_only"();

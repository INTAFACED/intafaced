-- Withdrawal destination allowlist (W-withdraw-10, wallet-withdraw-025/026/027). NO BALANCE LIVES HERE: the ledger is the only book.
-- An entry is a crypto address the owner may withdraw to while allowlist-only mode is on. Every change to the list, to the
-- one-time-send policy and the switch OFF is a governed CHANGE: it names one request hash (a digest of exactly what changes),
-- waits for an owner-set number of approvers, and is applied only when they have all approved. One rejection ends it. The
-- quorum is owner-set per user and read from its latest event; with no row the user has none and a change refuses. The mode
-- and the one-time policy are event-sourced (latest row wins), so with no row allowlist-only mode is off and one-time sends are
-- off. Entries, decisions and events are never deleted: removal is a state.
CREATE TABLE IF NOT EXISTS "pay"."allowlist_quorum_events" (
  "seq" bigserial PRIMARY KEY,
  "user_id" text NOT NULL,
  "team_account_id" uuid NOT NULL,
  "required_approvals" integer NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "allowlist_quorum_required_positive" CHECK ("required_approvals" >= 1),
  CONSTRAINT "allowlist_quorum_set_by_ck" CHECK (length(btrim("set_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "allowlist_quorum_latest_idx" ON "pay"."allowlist_quorum_events" ("user_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."allowlist_mode_events" (
  "seq" bigserial PRIMARY KEY,
  "user_id" text NOT NULL,
  "enabled" boolean NOT NULL,
  "set_by" text NOT NULL,
  "change_id" uuid,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "allowlist_mode_set_by_ck" CHECK (length(btrim("set_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "allowlist_mode_latest_idx" ON "pay"."allowlist_mode_events" ("user_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."allowlist_onetime_policy_events" (
  "seq" bigserial PRIMARY KEY,
  "user_id" text NOT NULL,
  "enabled" boolean NOT NULL,
  "asset_id" text NOT NULL,
  "max_amount" numeric(38,18) NOT NULL,
  "set_by" text NOT NULL,
  "change_id" uuid,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "allowlist_onetime_max_positive" CHECK ("max_amount" > 0),
  CONSTRAINT "allowlist_onetime_text_ck" CHECK (length(btrim("asset_id")) > 0 AND length(btrim("set_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "allowlist_onetime_latest_idx" ON "pay"."allowlist_onetime_policy_events" ("user_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."allowlist_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "client_ref" text NOT NULL,
  "op" text NOT NULL,
  "entry_id" uuid,
  "payload" jsonb NOT NULL,
  "request_hash" text NOT NULL,
  "team_account_id" uuid NOT NULL,
  "required_approvals" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'waiting',
  "failure_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  CONSTRAINT "allowlist_changes_ref_uq" UNIQUE ("user_id", "client_ref"),
  CONSTRAINT "allowlist_changes_op_ck" CHECK ("op" IN ('add', 'delete', 'mode_off', 'onetime_policy')),
  CONSTRAINT "allowlist_changes_status_ck" CHECK ("status" IN ('waiting', 'approved', 'cancelled', 'rejected', 'failed')),
  CONSTRAINT "allowlist_changes_required_positive" CHECK ("required_approvals" >= 1),
  CONSTRAINT "allowlist_changes_ref_ck" CHECK (length(btrim("client_ref")) > 0)
);
CREATE INDEX IF NOT EXISTS "allowlist_changes_team_idx" ON "pay"."allowlist_changes" ("team_account_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "allowlist_changes_user_idx" ON "pay"."allowlist_changes" ("user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "pay"."allowlist_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "group_kind" text NOT NULL,
  "asset_id" text NOT NULL,
  "address" text NOT NULL,
  "address_norm" text NOT NULL,
  "label" text NOT NULL,
  "state" text NOT NULL DEFAULT 'active',
  "created_by" text NOT NULL,
  "change_id" uuid REFERENCES "pay"."allowlist_changes" ("id"),
  "suspended_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "removed_at" timestamptz,
  CONSTRAINT "allowlist_entries_group_ck" CHECK ("group_kind" IN ('internal_wallet', 'external_wallet', 'contract')),
  CONSTRAINT "allowlist_entries_state_ck" CHECK ("state" IN ('active', 'suspended', 'removed')),
  CONSTRAINT "allowlist_entries_text_ck" CHECK (length(btrim("address")) > 0 AND length(btrim("label")) > 0 AND length(btrim("asset_id")) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "allowlist_entries_address_uq"
  ON "pay"."allowlist_entries" ("user_id", "asset_id", "address_norm") WHERE "state" <> 'removed';
CREATE UNIQUE INDEX IF NOT EXISTS "allowlist_entries_label_uq"
  ON "pay"."allowlist_entries" ("user_id", lower("label")) WHERE "state" <> 'removed';
CREATE INDEX IF NOT EXISTS "allowlist_entries_user_idx" ON "pay"."allowlist_entries" ("user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "pay"."allowlist_decisions" (
  "change_id" uuid NOT NULL REFERENCES "pay"."allowlist_changes" ("id"),
  "approver_id" text NOT NULL,
  "decision" text NOT NULL,
  "request_hash" text NOT NULL,
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("change_id", "approver_id"),
  CONSTRAINT "allowlist_decisions_ck" CHECK ("decision" IN ('approve', 'reject') AND length(btrim("approver_id")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."allowlist_events" (
  "seq" bigserial PRIMARY KEY,
  "user_id" text NOT NULL,
  "change_id" uuid REFERENCES "pay"."allowlist_changes" ("id"),
  "entry_id" uuid REFERENCES "pay"."allowlist_entries" ("id"),
  "kind" text NOT NULL,
  "actor_id" text NOT NULL,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "allowlist_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0)
);
CREATE INDEX IF NOT EXISTS "allowlist_events_user_idx" ON "pay"."allowlist_events" ("user_id", "seq");

CREATE OR REPLACE FUNCTION "pay"."allowlist_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS "allowlist_quorum_events_append_only_trg" ON "pay"."allowlist_quorum_events";
CREATE TRIGGER "allowlist_quorum_events_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."allowlist_quorum_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."allowlist_append_only"();
DROP TRIGGER IF EXISTS "allowlist_mode_events_append_only_trg" ON "pay"."allowlist_mode_events";
CREATE TRIGGER "allowlist_mode_events_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."allowlist_mode_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."allowlist_append_only"();
DROP TRIGGER IF EXISTS "allowlist_onetime_events_append_only_trg" ON "pay"."allowlist_onetime_policy_events";
CREATE TRIGGER "allowlist_onetime_events_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."allowlist_onetime_policy_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."allowlist_append_only"();
DROP TRIGGER IF EXISTS "allowlist_decisions_append_only_trg" ON "pay"."allowlist_decisions";
CREATE TRIGGER "allowlist_decisions_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."allowlist_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."allowlist_append_only"();
DROP TRIGGER IF EXISTS "allowlist_events_append_only_trg" ON "pay"."allowlist_events";
CREATE TRIGGER "allowlist_events_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."allowlist_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."allowlist_append_only"();

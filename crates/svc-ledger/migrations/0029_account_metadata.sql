-- intafaced:destructive TRUNCATE appears only in the BEFORE TRUNCATE guard trigger that refuses truncation; nothing is dropped or deleted
-- svc-ledger · operator metadata on ledger accounts (OPS-ledger-desk-01, J-ops-console-03 #6, #7)
-- Reversal: 0029_account_metadata.down.sql
--
-- An operator can label a ledger account with a key and a value (`ledger.accounts.setMetadata` in the desk's spec):
-- set, overwrite, or delete a key, always with a reason. A delete needs a second founder (svc-identity's action
-- approval, `ledger.account_metadata.delete`). Metadata is not a posting: nothing here touches an entry, a balance or
-- a transaction's own metadata (that is part of the hash chain and stays immutable, 0016). Both writes refuse while
-- the posting freeze is on, so a frozen book takes no operator write of any kind.
--
-- `account_metadata` holds each key's current value. A deleted key keeps its row with a NULL value, so its revision
-- only ever grows and an approval bound to one revision can never apply to a key set again later.
-- `account_metadata_changes` keeps every set and delete with the value before and after, who asked, who approved and
-- why. It is append-only.
--
-- Additive only: two new tables, nothing existing changes.

CREATE TABLE "ledger"."account_metadata" (
  "account_id" uuid NOT NULL,
  "key" text NOT NULL,
  "value" text,
  "revision" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text NOT NULL,
  CONSTRAINT "account_metadata_pk" PRIMARY KEY ("account_id", "key"),
  CONSTRAINT "account_metadata_account_fk" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts" ("id") ON DELETE RESTRICT,
  CONSTRAINT "account_metadata_key_ck" CHECK ("key" ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  CONSTRAINT "account_metadata_value_ck" CHECK ("value" IS NULL OR (length("value") BETWEEN 1 AND 500)),
  CONSTRAINT "account_metadata_revision_ck" CHECK ("revision" >= 1)
);

CREATE TABLE "ledger"."account_metadata_changes" (
  "seq" bigserial PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL,
  "key" text NOT NULL,
  "action" text NOT NULL,
  "before" text,
  "after" text,
  "revision" integer NOT NULL,
  "requester_id" text NOT NULL,
  "approver_id" text,
  "approval_id" text,
  "reason" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "account_metadata_changes_account_fk" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts" ("id") ON DELETE RESTRICT,
  CONSTRAINT "account_metadata_changes_revision_uq" UNIQUE ("account_id", "key", "revision"),
  CONSTRAINT "account_metadata_changes_approval_uq" UNIQUE ("approval_id"),
  CONSTRAINT "account_metadata_changes_action_ck" CHECK ("action" IN ('set', 'delete')),
  CONSTRAINT "account_metadata_changes_reason_ck" CHECK (length("reason") BETWEEN 12 AND 500),
  CONSTRAINT "account_metadata_changes_requester_ck" CHECK (length("requester_id") > 0),
  -- A set writes a value and needs no approver. A delete writes no value and names an approval whose approver is not
  -- the person who asked.
  CONSTRAINT "account_metadata_changes_shape_ck" CHECK (
    ("action" = 'set' AND "after" IS NOT NULL AND "approval_id" IS NULL AND "approver_id" IS NULL)
    OR ("action" = 'delete' AND "after" IS NULL AND "before" IS NOT NULL AND "approval_id" IS NOT NULL
        AND "approver_id" IS NOT NULL AND "approver_id" <> "requester_id")
  )
);

CREATE INDEX "account_metadata_changes_account_idx" ON "ledger"."account_metadata_changes" ("account_id", "seq");

CREATE OR REPLACE FUNCTION "ledger"."account_metadata_changes_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'account_metadata_changes is append-only: % refused', TG_OP
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "account_metadata_changes_append_only"
  BEFORE UPDATE OR DELETE ON "ledger"."account_metadata_changes"
  FOR EACH ROW EXECUTE FUNCTION "ledger"."account_metadata_changes_append_only"();

CREATE TRIGGER "account_metadata_changes_no_truncate"
  BEFORE TRUNCATE ON "ledger"."account_metadata_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger"."account_metadata_changes_append_only"();

-- Reading an account's metadata names that account, so it writes an access row first, like the desk's other reads.
ALTER TABLE "ledger"."operator_access_log" DROP CONSTRAINT "operator_access_log_action_ck";
ALTER TABLE "ledger"."operator_access_log"
  ADD CONSTRAINT "operator_access_log_action_ck"
  CHECK (action IN ('owner_balances.read', 'transaction.read', 'trace.read', 'transactions.list', 'accounts.search', 'account_metadata.read'));

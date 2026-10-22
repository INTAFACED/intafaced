-- svc-ledger · operator_access_log: one row per operator read of an owner's account detail (OPS-ledger-desk-01)
-- Reversal: 0024_operator_access_log.down.sql
--
-- The ledger desk lets a founder read any owner's balances. Every such read writes
-- one row here first (actor, owner read, request id, time); if the row cannot be
-- written the read is refused, so there is no unaudited path to a customer's detail.
--
-- Append-only: UPDATE and DELETE are refused by trigger, the same way posted history is.
--
-- Additive only: no existing table changes, so an old pod keeps working.

CREATE TABLE "ledger"."operator_access_log" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "actor_id" text NOT NULL,
  "action" text NOT NULL,
  "target_owner_type" text NOT NULL,
  "target_owner_id" text NOT NULL,
  "request_id" text,
  "accessed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "operator_access_log_actor_ck" CHECK (length(actor_id) > 0),
  CONSTRAINT "operator_access_log_action_ck" CHECK (action IN ('owner_balances.read'))
);

CREATE INDEX "operator_access_log_target_idx" ON "ledger"."operator_access_log" ("target_owner_type", "target_owner_id", "accessed_at");

CREATE OR REPLACE FUNCTION "ledger"."operator_access_log_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operator_access_log is append-only: % refused', TG_OP
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "operator_access_log_append_only"
  BEFORE UPDATE OR DELETE ON "ledger"."operator_access_log"
  FOR EACH ROW EXECUTE FUNCTION "ledger"."operator_access_log_append_only"();

CREATE TRIGGER "operator_access_log_no_truncate"
  BEFORE TRUNCATE ON "ledger"."operator_access_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger"."operator_access_log_append_only"();

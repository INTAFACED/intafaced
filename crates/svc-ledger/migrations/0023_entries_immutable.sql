-- intafaced:destructive — false positive: this file removes no data; it only creates BEFORE TRUNCATE guard triggers that refuse TRUNCATE.
-- svc-ledger · posted history is append-only in the database, and every posted transaction balances
-- Reversal: 0023_entries_immutable.down.sql
--
-- THE GAP
--
-- Until now the book's integrity rested on three things, none of which stopped
-- an UPDATE, DELETE or TRUNCATE typed by someone with write access:
--
--   · the double-entry sum was checked in application code only
--     (assertBalanced, postgres-ledger.ts); a raw INSERT could write a
--     transaction that does not sum to zero;
--   · ledger_entries had no guard against UPDATE / DELETE / TRUNCATE. Tampering
--     was detectable after the fact (verifyChain, reconcile, which run on a
--     schedule) but not refused when it happened;
--   · ledger_tx was guarded only for idempotency_key and meta (0016).
--
-- This migration makes the database itself refuse all of that. Detection stays
-- (reconcile and verifyChain are untouched); this adds prevention.
--
-- WHAT THE APPLICATION WRITES TODAY (checked before this was written)
--
--   · INSERT into ledger_tx and ledger_entries, in one transaction.
--   · UPDATE accounts.balance and chain_tip, in that same transaction. Both
--     stay writable; this migration does not touch them.
--   · UPDATE ledger_tx_outbox.published_at. Untouched.
--   · Nothing ever UPDATEs or DELETEs ledger_tx or ledger_entries, so those
--     two tables can be made fully append-only without breaking a write path.
--
-- SQLSTATE
--
-- 23514 (check_violation), the code 0016 and 0017 already use for "this row may
-- not change". The message names the table and the rule. The break-glass
-- procedure (README, "Break-glass") disables these triggers by name; it is the
-- only sanctioned way past them and it runs as the migration role.
--
-- NOT DONE HERE
--
-- No REVOKE: this repo does not manage a separate application role in
-- migrations, so a REVOKE would target a role that may not exist. Revoking
-- UPDATE/DELETE/TRUNCATE on these two tables from the runtime role is the
-- natural second layer and belongs with whatever provisions that role.

-- ---------------------------------------------------------------------------
-- 1. ledger_entries and ledger_tx: no UPDATE, no DELETE
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "ledger"."ledger_journal_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused (posted ledger history cannot be changed; use a reversing post)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS "ledger_entries_immutable" ON "ledger"."ledger_entries";
CREATE TRIGGER "ledger_entries_immutable"
  BEFORE UPDATE OR DELETE ON "ledger"."ledger_entries"
  FOR EACH ROW
  EXECUTE FUNCTION "ledger"."ledger_journal_immutable"();

-- ledger_tx: the application never updates it, so every column is immutable.
-- (0016's idempotency_key/meta trigger stays as a second, narrower guard.)
DROP TRIGGER IF EXISTS "ledger_tx_immutable" ON "ledger"."ledger_tx";
CREATE TRIGGER "ledger_tx_immutable"
  BEFORE UPDATE OR DELETE ON "ledger"."ledger_tx"
  FOR EACH ROW
  EXECUTE FUNCTION "ledger"."ledger_journal_immutable"();

-- ---------------------------------------------------------------------------
-- 2. No TRUNCATE of the journal
-- ---------------------------------------------------------------------------
-- TRUNCATE skips row triggers, so it needs its own statement-level trigger.
-- It also fires when the table is emptied through TRUNCATE ... CASCADE from a
-- referenced table (for example accounts), which is the usual accidental route.

CREATE OR REPLACE FUNCTION "ledger"."ledger_journal_no_truncate"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: TRUNCATE refused (posted ledger history cannot be erased)',
    TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS "ledger_entries_no_truncate" ON "ledger"."ledger_entries";
CREATE TRIGGER "ledger_entries_no_truncate"
  BEFORE TRUNCATE ON "ledger"."ledger_entries"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "ledger"."ledger_journal_no_truncate"();

DROP TRIGGER IF EXISTS "ledger_tx_no_truncate" ON "ledger"."ledger_tx";
CREATE TRIGGER "ledger_tx_no_truncate"
  BEFORE TRUNCATE ON "ledger"."ledger_tx"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "ledger"."ledger_journal_no_truncate"();

-- ---------------------------------------------------------------------------
-- 3. Every transaction nets to zero per asset, checked at COMMIT
-- ---------------------------------------------------------------------------
-- The posting path inserts a ledger_tx row and all of its entries inside one
-- database transaction, so the sum can be checked when that transaction
-- commits. The trigger is DEFERRABLE INITIALLY DEFERRED, so entries may be
-- inserted one at a time and only the final state is judged.
--
-- Sign convention is the one the code uses (signedDelta, reconcile.ts):
-- debit adds, credit subtracts. A transaction balances when, for each asset,
-- debits equal credits.
--
-- It fires once per inserted entry (each runs one indexed query on tx_id, a
-- handful of rows). It only judges transactions that gain an entry in the
-- committing transaction; rows already posted are not re-checked (they cannot
-- change any more, see section 1).

CREATE OR REPLACE FUNCTION "ledger"."ledger_tx_must_balance"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bad_asset text;
  bad_sum numeric;
BEGIN
  SELECT e.asset_id,
         SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END)
    INTO bad_asset, bad_sum
    FROM "ledger"."ledger_entries" e
   WHERE e.tx_id = NEW.tx_id
   GROUP BY e.asset_id
  HAVING SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END) <> 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'ledger_tx % does not balance: asset % nets to % (debits must equal credits per asset)',
      NEW.tx_id, bad_asset, bad_sum
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "ledger_entries_tx_must_balance" ON "ledger"."ledger_entries";
CREATE CONSTRAINT TRIGGER "ledger_entries_tx_must_balance"
  AFTER INSERT ON "ledger"."ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "ledger"."ledger_tx_must_balance"();

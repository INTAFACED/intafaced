-- svc-ledger · reconcile_runs: one row per reconciliation attempt that reached an outcome
-- Reversal: 0022_reconcile_runs.down.sql
--
-- Scheduled and operator reconciliation used to leave no record of its own
-- result. A proof that could not finish (statement timeout, lost connection)
-- was indistinguishable from one that found a mismatch, and the only trace of
-- either was a freeze row and a log line. Issue #4755.
--
-- outcome
--   ok          the proof completed and the book is consistent through through_seq.
--   mismatch    the proof completed and found drift, a broken chain or an
--               unbalanced asset. Posting is frozen in the same short verdict transaction.
--   incomplete  the proof could not reach a verdict. NOTHING is frozen by this
--               row, even if verification stays stale.
--
-- through_seq / through_entry_id / tip_hash name the committed prefix of the
-- book the proof read (one REPEATABLE READ snapshot). They are NULL on an
-- incomplete run that failed before the tip was read.
--
-- kind is 'full' today. 'incremental' is allowed by the check so a later
-- checkpointed proof does not need to widen it.
--
-- Additive only: no existing table changes, so an old pod keeps working.

CREATE TABLE "ledger"."reconcile_runs" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "outcome" text NOT NULL,
  "kind" text DEFAULT 'full' NOT NULL,
  "through_seq" bigint,
  "through_entry_id" text,
  "tip_hash" text,
  "error_code" text,
  "detail" jsonb,
  CONSTRAINT "reconcile_runs_outcome_ck" CHECK (outcome IN ('ok', 'mismatch', 'incomplete')),
  CONSTRAINT "reconcile_runs_kind_ck" CHECK (kind IN ('full', 'incremental')),
  CONSTRAINT "reconcile_runs_ok_has_tip_ck" CHECK (outcome <> 'ok' OR through_seq IS NOT NULL)
);

-- "When was the book last proved?" is asked on every /health call and every tick.
CREATE INDEX "reconcile_runs_ok_idx" ON "ledger"."reconcile_runs" USING btree ("through_seq" DESC NULLS LAST, "id" DESC NULLS LAST) WHERE outcome = 'ok';

-- svc-ledger · durable posting freeze
-- Reversal: 0002_durable_freeze.down.sql
--
-- Until now the freeze lived in one process's memory: a `boolean` field on
-- LedgerService. Three ways that loses:
--
--   1. A restart silently UNFREEZES a ledger that detected drift. The most
--      important safety action in the system was undone by a deploy.
--   2. A second replica never knew. Replica A freezes on a reconciliation
--      mismatch; replica B keeps posting to the same book, happily.
--   3. The operator's reason — the only record of WHY the platform halted —
--      was never written anywhere.
--
-- Single row, same shape as `chain_tip` above it, and for the same reason: the
-- state it holds is global, so representing it as anything other than one row
-- invites the question "which one is authoritative".

CREATE TABLE IF NOT EXISTS "ledger"."posting_freeze" (
  "id"         boolean PRIMARY KEY DEFAULT true,
  "frozen"     boolean NOT NULL DEFAULT false,
  -- Free text on purpose: this is what a human reads at 3am to decide whether
  -- the halt can be lifted. A code would be tidier and useless.
  "reason"     text,
  -- WHO froze it. An operator principal id, 'reconciliation' for the automatic
  -- self-freeze, or 'env:LEDGER_POSTING_ENABLED' for a boot-time freeze.
  "actor"      text,
  "changed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "posting_freeze_singleton_ck" CHECK ("id" = true),
  -- A freeze with no reason and no actor is unactionable: the operator who
  -- finds it cannot tell a deliberate halt from a bug, and the safe response to
  -- "I do not know why the ledger is frozen" is to leave the platform down.
  CONSTRAINT "posting_freeze_attributed_ck"
    CHECK ("frozen" = false OR (length(coalesce("reason", '')) > 0 AND length(coalesce("actor", '')) > 0))
);

-- Seeded unfrozen. An existing database is a running platform; a migration that
-- halted it on the way past would be a worse bug than the one being fixed.
INSERT INTO "ledger"."posting_freeze" ("id", "frozen", "reason", "actor")
  VALUES (true, false, NULL, NULL)
  ON CONFLICT ("id") DO NOTHING;

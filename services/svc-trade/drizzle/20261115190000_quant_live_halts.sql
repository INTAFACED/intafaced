-- trade.quant_live_halts, trade.quant_live_halt_requests · the risk desk's halt of one live strategy or of every one
-- (J-algo-dev-11; src/quant/live-run/halts.ts).
-- Reversal: 20261115190000_quant_live_halts.down.sql
--
-- A halt is a row per (person, strategy) while it stands: the live run of a halted strategy places no new order and a
-- new run of it is refused, while a reduce-only exit (Liquidate) still passes. One operator halts one strategy with a
-- reason. Halting every strategy, and every restore, needs two founders: the first records a request bound to their
-- identity approval, the second confirms it. Nothing here is money: a halt places, cancels and closes nothing. The audit
-- rows are trade.operator_audit's, kind `quant_live.*`.

CREATE TABLE IF NOT EXISTS trade.quant_live_halt_requests (
  id uuid PRIMARY KEY,
  op text NOT NULL CONSTRAINT quant_live_halt_requests_op_ck CHECK (op IN ('halt_all', 'restore', 'restore_all')),
  -- The halt a restore lifts; null for halt_all and restore_all.
  halt_id uuid,
  user_id text,
  strategy_id text,
  reason text NOT NULL CONSTRAINT quant_live_halt_requests_reason_ck CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  status text NOT NULL CONSTRAINT quant_live_halt_requests_status_ck CHECK (status IN ('awaiting_second', 'applied')),
  approval_id text NOT NULL,
  proposed_by text NOT NULL,
  approver_id text,
  confirmed_by text,
  -- How many live runs the confirm halted (halt_all) or released (restore, restore_all).
  applied_runs integer,
  applied_strategies integer,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  CONSTRAINT quant_live_halt_requests_target_ck CHECK ((op = 'restore') = (halt_id IS NOT NULL)),
  CONSTRAINT quant_live_halt_requests_decided_ck CHECK ((status = 'applied') = (decided_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS trade.quant_live_halts (
  id uuid PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT quant_live_halts_user_ck CHECK (length(btrim(user_id)) > 0),
  -- svc-quant's strategy id: opaque here, never a join.
  strategy_id text NOT NULL,
  -- 'one': one operator halted this strategy; 'all': the two-founder halt of every strategy (halt_request_id).
  scope text NOT NULL CONSTRAINT quant_live_halts_scope_ck CHECK (scope IN ('one', 'all')),
  reason text NOT NULL,
  halted_by text NOT NULL,
  halt_approver text,
  halt_request_id uuid REFERENCES trade.quant_live_halt_requests (id),
  halted_at timestamptz NOT NULL,
  restore_request_id uuid REFERENCES trade.quant_live_halt_requests (id),
  restored_by text,
  restore_approver text,
  restored_at timestamptz,
  CONSTRAINT quant_live_halts_all_ck CHECK (scope = 'one' OR (halt_approver IS NOT NULL AND halt_request_id IS NOT NULL)),
  CONSTRAINT quant_live_halts_restore_ck CHECK (
    (restored_at IS NULL AND restored_by IS NULL AND restore_approver IS NULL AND restore_request_id IS NULL)
    OR (restored_at IS NOT NULL AND restored_by IS NOT NULL AND restore_approver IS NOT NULL AND restore_request_id IS NOT NULL)
  )
);

-- One standing halt per strategy.
CREATE UNIQUE INDEX IF NOT EXISTS quant_live_halts_active_uq ON trade.quant_live_halts (user_id, strategy_id) WHERE restored_at IS NULL;

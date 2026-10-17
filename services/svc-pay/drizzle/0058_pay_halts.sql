-- W5 granular halts. ONE row per (scope, target): the CURRENT switch, shared by
-- every svc-pay replica because it lives here and nowhere in process memory.
-- A missing row means "never halted" (version 0). An unreadable table is read by
-- the guards as HALTED, never as "not halted".
CREATE TABLE pay.halts (
  scope text NOT NULL CHECK (scope IN ('intake', 'conversion', 'payout', 'settlement')),
  target text NOT NULL CHECK (target = 'global' OR target ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  halted boolean NOT NULL,
  reason text,
  source text NOT NULL CHECK (source IN ('operator', 'auto_trip')),
  actor_user_id uuid,
  version bigint NOT NULL CHECK (version >= 1),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, target),
  -- A halt is always explained; an operator halt names who set it.
  CHECK (reason IS NOT NULL AND length(btrim(reason)) > 0),
  CHECK (source <> 'operator' OR actor_user_id IS NOT NULL)
);

-- Every change, in order, never rewritten. `confirmed_by_user_id` is the second
-- founder on a dual-controlled clear. `request_id` makes a retried call a repeat.
CREATE TABLE pay.halt_events (
  id bigserial PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('intake', 'conversion', 'payout', 'settlement')),
  target text NOT NULL,
  halted boolean NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  source text NOT NULL CHECK (source IN ('operator', 'auto_trip')),
  actor_user_id uuid,
  confirmed_by_user_id uuid,
  request_id uuid,
  version bigint NOT NULL CHECK (version >= 1),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source <> 'operator' OR actor_user_id IS NOT NULL),
  CHECK (confirmed_by_user_id IS NULL OR (actor_user_id IS NOT NULL AND confirmed_by_user_id <> actor_user_id))
);
CREATE UNIQUE INDEX pay_halt_events_request_idx ON pay.halt_events (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX pay_halt_events_scope_idx ON pay.halt_events (scope, target, id DESC);

-- A clear needs two distinct founders: the first proposes (a row here), the
-- second repeats the same call and applies it. Nothing is cleared by one person.
CREATE TABLE pay.halt_clear_requests (
  request_id uuid PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('intake', 'conversion', 'payout', 'settlement')),
  target text NOT NULL,
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_by_user_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied'))
);

-- Consecutive failures per (scope, target, source key such as `venue:binance`).
-- A success resets it; reaching the configured count sets the halt (auto_trip).
CREATE TABLE pay.halt_failure_streaks (
  scope text NOT NULL CHECK (scope IN ('intake', 'conversion', 'payout', 'settlement')),
  target text NOT NULL,
  source_key text NOT NULL CHECK (length(btrim(source_key)) > 0),
  consecutive_failures bigint NOT NULL CHECK (consecutive_failures >= 0),
  last_failure_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, target, source_key)
);

CREATE FUNCTION pay.halt_rows_not_deletable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pay.halt_record_not_deletable'; END; $$;
CREATE TRIGGER pay_halts_no_delete BEFORE DELETE ON pay.halts FOR EACH ROW EXECUTE FUNCTION pay.halt_rows_not_deletable();
CREATE TRIGGER pay_halt_events_immutable BEFORE UPDATE OR DELETE ON pay.halt_events FOR EACH ROW EXECUTE FUNCTION pay.founder_control_records_immutable();
CREATE TRIGGER pay_halt_clear_requests_no_delete BEFORE DELETE ON pay.halt_clear_requests FOR EACH ROW EXECUTE FUNCTION pay.halt_rows_not_deletable();

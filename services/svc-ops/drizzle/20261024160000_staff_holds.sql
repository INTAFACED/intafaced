-- svc-ops · staff holds on funds (OPS-accounts-desk-01, ops ENGINE LC-8 and LC-9)
-- Reversal: 20261024160000_staff_holds.down.sql
--
-- The held value is in the ledger, in the customer's own `ops:hold:<holdNo>` pot. These rows record what svc-ops asked
-- the ledger to do and what it answered. `hold_no` is the one global hold sequence the ledger keys are built from, so a
-- key names exactly one hold. Every post is a movement row stored (with its number and key) before it is sent; its
-- answer is written back once known. Movement rows are never deleted, and a settled movement never changes again.
CREATE TABLE ops.staff_holds (
 hold_no bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 place_key text NOT NULL UNIQUE,
 user_id text NOT NULL,
 asset_id text NOT NULL,
 amount numeric(38, 18) NOT NULL CHECK (amount > 0),
 remaining numeric(38, 18) NOT NULL CHECK (remaining >= 0 AND remaining <= amount),
 state text NOT NULL CHECK (state IN ('placing', 'active', 'partially_released', 'released', 'confirmed', 'expired', 'refused')),
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 80),
 expires_at timestamptz,
 placed_by text NOT NULL,
 placed_at timestamptz NOT NULL
);
CREATE INDEX staff_holds_user_idx ON ops.staff_holds (user_id, hold_no DESC);
CREATE INDEX staff_holds_expiry_idx ON ops.staff_holds (expires_at) WHERE expires_at IS NOT NULL AND state IN ('active', 'partially_released');

CREATE TABLE ops.staff_hold_movements (
 hold_no bigint NOT NULL REFERENCES ops.staff_holds (hold_no),
 kind text NOT NULL CHECK (kind IN ('place', 'release', 'confirm')),
 no integer NOT NULL CHECK (no >= 1),
 amount numeric(38, 18) NOT NULL CHECK (amount > 0),
 status text NOT NULL CHECK (status IN ('settling', 'posted', 'refused', 'pending_retry')),
 cause text NOT NULL CHECK (cause IN ('staff', 'approval', 'expiry')),
 ledger_key text NOT NULL UNIQUE,
 request_key text NOT NULL UNIQUE,
 approval_id text,
 requester_id text,
 approver_id text,
 expires_at timestamptz,
 confirm_account text,
 tx_id text,
 code text,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 uncertain boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL,
 last_attempt_at timestamptz,
 settled_at timestamptz,
 PRIMARY KEY (hold_no, kind, no),
 -- A staff release and a confirm name the second founder's approval; only the expiry worker releases without one.
 CHECK ((cause = 'approval') = (approval_id IS NOT NULL)),
 CHECK (cause <> 'expiry' OR (kind = 'release' AND expires_at IS NOT NULL)),
 CHECK (kind <> 'confirm' OR confirm_account IS NOT NULL),
 CHECK (status <> 'posted' OR tx_id IS NOT NULL)
);
CREATE INDEX staff_hold_movements_open_idx ON ops.staff_hold_movements (hold_no) WHERE status IN ('settling', 'pending_retry');

-- A settled movement is history: its answer, key and amount never change, and no movement is deleted.
CREATE FUNCTION ops.staff_hold_movements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'ops.staff_hold_movements rows are never deleted' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD.status IN ('posted', 'refused') THEN
  RAISE EXCEPTION 'a settled staff hold movement never changes' USING ERRCODE = 'restrict_violation';
 END IF;
 IF NEW.hold_no <> OLD.hold_no OR NEW.kind <> OLD.kind OR NEW.no <> OLD.no OR NEW.amount <> OLD.amount
    OR NEW.ledger_key <> OLD.ledger_key OR NEW.request_key <> OLD.request_key OR NEW.cause <> OLD.cause THEN
  RAISE EXCEPTION 'a staff hold movement keeps its key, number and amount' USING ERRCODE = 'restrict_violation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER staff_hold_movements_guard BEFORE UPDATE OR DELETE ON ops.staff_hold_movements
 FOR EACH ROW EXECUTE FUNCTION ops.staff_hold_movements_guard();

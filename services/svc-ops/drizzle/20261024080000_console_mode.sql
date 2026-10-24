-- svc-ops · founder console maintenance mode (OPS-admin-access-08)
-- Reversal: 20261024080000_console_mode.down.sql
--
-- One row holds whether the console is read-only, why, and who asked and approved. It is absent until the first change, and
-- an absent row reads as off: nothing is seeded. Every change, including one that found the mode already in that state, is
-- appended to the log under its business key (`ops.console_mode.on:<approvalId>`), and the log refuses update and delete.
-- This is the console's own switch: it is neither the posting freeze (svc-ledger) nor an account freeze (svc-identity).
CREATE TABLE ops.console_mode (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 read_only boolean NOT NULL,
 -- The 12 to 500 limit is the contract's, counted in UTF-16 units before the approval is spent. Code points are never more,
 -- so this bound can only hold once that one has: a reason that passed it is never refused here after the spend.
 reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
 revision integer NOT NULL CHECK (revision >= 1),
 requester_id text NOT NULL,
 approver_id text NOT NULL,
 changed_at timestamptz NOT NULL,
 CHECK (read_only = (reason IS NOT NULL))
);
CREATE TABLE ops.console_mode_log (
 key text PRIMARY KEY,
 action text NOT NULL CHECK (action IN ('ops.console_mode.on', 'ops.console_mode.off')),
 outcome text NOT NULL CHECK (outcome IN ('changed', 'noop')),
 read_only_after boolean NOT NULL,
 reason text,
 revision_after integer NOT NULL,
 approval_id text NOT NULL,
 requester_id text NOT NULL,
 approver_id text NOT NULL,
 policy_version text NOT NULL,
 logged_at timestamptz NOT NULL
);
CREATE FUNCTION ops.console_mode_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.console_mode_log is append-only' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER console_mode_log_append_only BEFORE UPDATE OR DELETE ON ops.console_mode_log FOR EACH ROW EXECUTE FUNCTION ops.console_mode_log_append_only();

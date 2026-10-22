-- trade.copy · lead trader applications (CB-copy-12, copy-bots-otc-copy-012).
-- One row per (user, lead mode); the business key is copy.leader_apply:<userId>:<mode>.
-- A disapproved row is reused on resubmit; a listing is never created here (founder approval, CB-ops-01).
-- Reversal: 0086_copy_leader_applications.down.sql
CREATE TABLE IF NOT EXISTS trade.copy_leader_applications (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  user_id text NOT NULL,
  lead_mode text NOT NULL CHECK (lead_mode IN ('spot', 'futures')),
  nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 40),
  contact text NOT NULL CHECK (char_length(contact) BETWEEN 1 AND 200),
  trading_style text NOT NULL CHECK (char_length(trading_style) BETWEEN 1 AND 500),
  markets jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('submitted', 'under_review', 'approved', 'disapproved')),
  decided_by text,
  decision_reason text,
  decided_at timestamptz,
  submitted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, lead_mode)
);

-- trade.own_funds_sweeps · each move of our collected builder fees from our builder account at a venue to a wallet we
-- control, above the float (OWNER 288 Q4; src/builder-fee/own-funds-sweep.ts). Reversal: 20261114140000_own_funds_sweeps.down.sql
--
-- One row per sweep, stored with its prepared, signed withdrawal BEFORE it is sent, so a crash after the send reads it back
-- by its nonce and never sends a second one. Nothing here is a balance: the ledger's `ownFundsMove` under the chain
-- transaction is the record of the move, and `ledger_tx_id` names it once posted.

CREATE TABLE IF NOT EXISTS trade.own_funds_sweeps (
  key text PRIMARY KEY CONSTRAINT own_funds_sweeps_key_ck CHECK (key ~ '^own-funds-sweep:[a-z0-9][a-z0-9_-]*:[0-9]+$'),
  venue_id text NOT NULL CONSTRAINT own_funds_sweeps_venue_ck CHECK (length(btrim(venue_id)) > 0),
  seq integer NOT NULL CONSTRAINT own_funds_sweeps_seq_ck CHECK (seq > 0),
  prepared jsonb NOT NULL,
  signature jsonb NOT NULL,
  state text NOT NULL CONSTRAINT own_funds_sweeps_state_ck CHECK (state IN ('sent', 'held', 'posted', 'failed')),
  reason text,
  tx_hash text,
  ledger_tx_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT own_funds_sweeps_posted_ck CHECK (state <> 'posted' OR (tx_hash IS NOT NULL AND ledger_tx_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS own_funds_sweeps_seq_uq ON trade.own_funds_sweeps (venue_id, seq);
-- At most one open sweep per venue.
CREATE UNIQUE INDEX IF NOT EXISTS own_funds_sweeps_open_uq ON trade.own_funds_sweeps (venue_id) WHERE state IN ('sent', 'held');

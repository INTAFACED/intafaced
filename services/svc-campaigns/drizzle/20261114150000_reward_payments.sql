-- Paying a reward INTAFACED owes to the customer's own wallet (launch money model, docs/adr/2026-11-10-launch-money-model.md;
-- J-campaigns-03 #2 #3, #8195). Reversal: the matching .down.sql.
--
-- The wallet a reward is paid to is the one the customer had connected when they claimed it (`pay_to_wallet`, read for
-- them from svc-protocol during their own request). One payment per reward (`reward_payments`, keyed by the reward), written
-- BEFORE it is sent with where it goes, how much and the chain's block then, so a send with no answer is looked up on the
-- chain by those facts and never sent again. Once the chain's receipt succeeds the payment is booked (`rewardPayOut`, keyed
-- by the chain transaction) and the reward is `paid`.

ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS pay_to_wallet text;
ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS paid_chain_tx text;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_pay_to_ck CHECK (pay_to_wallet IS NULL OR pay_to_wallet ~ '^0x[0-9a-f]{40}$');

ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_state_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_state_ck CHECK (state IN ('held', 'qualified', 'posting',
  'owed', 'paid', 'locked', 'settling', 'posted', 'pending_funding', 'pending_retry', 'unknown', 'withheld', 'failed', 'forfeited'));

ALTER TABLE campaigns.redemption_attempts DROP CONSTRAINT IF EXISTS redemption_attempts_outcome_ck;
ALTER TABLE campaigns.redemption_attempts ADD CONSTRAINT redemption_attempts_outcome_ck CHECK (outcome IN ('held', 'released',
  'qualified', 'owed', 'paid', 'posted', 'locked', 'unlocked', 'refused', 'unknown', 'withheld', 'forfeited'));

CREATE TABLE IF NOT EXISTS campaigns.reward_payments (
  reward_key text PRIMARY KEY REFERENCES campaigns.reward_intents (reward_key),
  -- Our own-funds place it is paid from (`<chain>:<name>`), the customer's wallet, and the amount in the token's units.
  from_place text NOT NULL,
  to_wallet text NOT NULL CHECK (to_wallet ~ '^0x[0-9a-f]{40}$'),
  asset text NOT NULL,
  amount numeric(38, 18) NOT NULL CHECK (amount > 0),
  units numeric(78, 0) NOT NULL CHECK (units > 0),
  -- The chain's head when it was sent, so a send with no answer is found on the chain from there.
  from_block numeric(78, 0) NOT NULL,
  sent_at timestamptz NOT NULL,
  -- Null while the send has no answer. `sending` until its receipt; `sent` once it succeeded and before it is booked;
  -- `booked` with the ledger's transaction; `failed` when it reverted or the chain never took it (never sent again).
  chain_tx text UNIQUE,
  state text NOT NULL DEFAULT 'sending' CHECK (state IN ('sending', 'sent', 'booked', 'failed')),
  paid_tx_id text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reward_payments_booked_ck CHECK (state <> 'booked' OR (chain_tx IS NOT NULL AND paid_tx_id IS NOT NULL)),
  CONSTRAINT reward_payments_sent_ck CHECK (state <> 'sent' OR chain_tx IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS reward_payments_open_idx ON campaigns.reward_payments (state) WHERE state IN ('sending', 'sent');

-- A paid reward names its payment's ledger transaction, was owed first, and is a paid-form reward.
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_paid_ck CHECK (
  state <> 'paid' OR (owe_tx_id IS NOT NULL AND ledger_tx_id IS NOT NULL AND paid_at IS NOT NULL AND paid_chain_tx IS NOT NULL
    AND pay_to_wallet IS NOT NULL AND form = 'paid'));

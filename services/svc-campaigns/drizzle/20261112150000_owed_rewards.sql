-- Rewards INTAFACED owes (launch money model, docs/adr/2026-11-10-launch-money-model.md; J-campaigns-03). Reversal: the
-- matching .down.sql.
--
-- A claimed USDC reward paid in full (form `paid`) is never credited to a customer balance. The saga posts the
-- campaign's budget funding and then `rewardOwe` (`campaigns:owe:` || reward_key), and the intent is `owed` with that
-- transaction in `owe_tx_id`. A held reward is owed at its claim; its hold only delays the payment to the customer's
-- own wallet. `ledger_tx_id` stays the payment's transaction, so an owed reward has none.

ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS owe_tx_id text;
ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS owed_at timestamptz;

ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_state_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_state_ck CHECK (state IN ('held', 'qualified', 'posting',
  'owed', 'locked', 'settling', 'posted', 'pending_funding', 'pending_retry', 'unknown', 'withheld', 'failed', 'forfeited'));
-- An owed reward names the Owe transaction and is a paid-form reward.
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_owed_ck CHECK (
  state <> 'owed' OR (owe_tx_id IS NOT NULL AND owed_at IS NOT NULL AND form = 'paid' AND ledger_tx_id IS NULL));

ALTER TABLE campaigns.redemption_attempts DROP CONSTRAINT IF EXISTS redemption_attempts_outcome_ck;
ALTER TABLE campaigns.redemption_attempts ADD CONSTRAINT redemption_attempts_outcome_ck CHECK (outcome IN ('held', 'released',
  'qualified', 'owed', 'posted', 'locked', 'unlocked', 'refused', 'unknown', 'withheld', 'forfeited'));

-- The reward pot may also be funded from builder fees the venues credited us (the launch build's fee income).
ALTER TABLE campaigns.pot_fundings DROP CONSTRAINT IF EXISTS pot_fundings_module_ck;
ALTER TABLE campaigns.pot_fundings ADD CONSTRAINT pot_fundings_module_ck CHECK (source_module IN ('trade', 'builder'));

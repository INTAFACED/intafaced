-- Locked rewards and bonuses (CM-payouts-ledger-01 locked part, CM-rewards-hub-02, J-campaigns-03 #4-#6). Reversal: the
-- matching .down.sql.
--
-- A claimed reward on a campaign that gives it locked or as a bonus is written with that form and its terms (lock seconds)
-- before any ledger call. The saga posts `campaignRewardLock` under `campaigns:lock:` || reward_key, and the intent is
-- `locked` with its lock transaction and the time the lock ends. A locked reward counts the fills of its unlock step made
-- while it is locked, one row per fill. When the step is done, or the lock ends without it, the outcome is written first
-- (`settling` with `settle` = unlock or forfeit) and then posted under its own key: an unlock makes the reward `posted`,
-- a forfeit `forfeited`. A forfeited reward is never given again. Nothing here is a balance: the pot is svc-ledger's.

ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS form text NOT NULL DEFAULT 'paid';
ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS lock_seconds integer;
ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS lock_tx_id text;
ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS lock_until timestamptz;
ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS settle text;

ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_state_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_state_ck CHECK (state IN ('held', 'qualified', 'posting',
  'locked', 'settling', 'posted', 'pending_funding', 'pending_retry', 'unknown', 'withheld', 'failed', 'forfeited'));
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_form_ck CHECK (form IN ('paid', 'locked', 'bonus'));
-- A locked reward or bonus knows how long its lock lasts before anything posts; a paid one has none.
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_lock_terms_ck CHECK (
  (form = 'paid') = (lock_seconds IS NULL) AND (lock_seconds IS NULL OR lock_seconds > 0));
-- Locked and settling rows name their posted lock and when it ends; only they and their outcome carry a lock.
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_locked_ck CHECK (
  state NOT IN ('locked', 'settling') OR (lock_tx_id IS NOT NULL AND locked_at IS NOT NULL AND lock_until IS NOT NULL));
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_settle_ck CHECK (
  (settle IS NULL OR settle IN ('unlock', 'forfeit')) AND (state <> 'settling' OR settle IS NOT NULL)
  AND (settle IS NULL OR lock_tx_id IS NOT NULL));
-- An unlocked reward is posted with the unlock transaction; a forfeited lock names the forfeit transaction.
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_posted_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_posted_ck CHECK (
  (state <> 'posted' OR ledger_tx_id IS NOT NULL)
  AND (ledger_tx_id IS NULL OR state = 'posted' OR (state = 'forfeited' AND settle = 'forfeit')));

CREATE INDEX IF NOT EXISTS reward_intents_locked_idx ON campaigns.reward_intents (lock_until) WHERE state IN ('locked', 'settling');

-- The unlock step's fills, one row per fill, counted only while the reward is locked.
CREATE TABLE IF NOT EXISTS campaigns.lock_progress (
  reward_key text NOT NULL REFERENCES campaigns.reward_intents (reward_key),
  event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reward_key, event_id)
);

ALTER TABLE campaigns.redemption_attempts DROP CONSTRAINT IF EXISTS redemption_attempts_outcome_ck;
ALTER TABLE campaigns.redemption_attempts ADD CONSTRAINT redemption_attempts_outcome_ck CHECK (outcome IN ('held', 'released',
  'qualified', 'posted', 'locked', 'unlocked', 'refused', 'unknown', 'withheld', 'forfeited'));

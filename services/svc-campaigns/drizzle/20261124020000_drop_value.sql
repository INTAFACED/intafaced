-- Limited drops with value (RC-campaigns-04, J-campaigns-20 #5; the Money line). A drop may name a `drop` campaign: its
-- reward is what one claim is worth and its budget pays it. Each claim of such a drop writes one reward intent under the
-- claim's own business key (`drop:<drop>:<account>`), owed once through the reward saga and paid once to the claimer's
-- connected wallet by the reward payer. A drop with no campaign stays an entitlement. Nothing here is a balance.
-- Reversal: the matching .down.sql.

ALTER TABLE campaigns.campaigns DROP CONSTRAINT IF EXISTS campaigns_type_ck;
ALTER TABLE campaigns.campaigns ADD CONSTRAINT campaigns_type_ck CHECK (type IN ('referral', 'task', 'voucher', 'competition',
  'milestone', 'draw', 'pool', 'distribution', 'trial_pass', 'gift_card', 'points', 'welcome', 'drop'));

ALTER TABLE campaigns.drops ADD COLUMN IF NOT EXISTS campaign_id text REFERENCES campaigns.campaigns (id);
ALTER TABLE campaigns.drops DROP CONSTRAINT IF EXISTS drops_kind_ck;
ALTER TABLE campaigns.drops ADD CONSTRAINT drops_kind_ck CHECK (
  (kind = 'entitlement' AND campaign_id IS NULL) OR (kind = 'value' AND campaign_id IS NOT NULL));

ALTER TABLE campaigns.drop_claims DROP CONSTRAINT IF EXISTS drop_claims_kind_ck;
ALTER TABLE campaigns.drop_claims ADD CONSTRAINT drop_claims_kind_ck CHECK (kind IN ('entitlement', 'value'));

ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_key_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_key_ck CHECK (
  reward_key = 'task:' || campaign_id || ':' || account_id || ':' || period
  OR (period ~ '^voucher:[^:]+:[1-9][0-9]*$'
    AND reward_key = 'voucher:' || split_part(period, ':', 2) || ':' || account_id || ':' || split_part(period, ':', 3))
  OR (period ~ '^competition:[1-9][0-9]*$'
    AND reward_key = 'competition:' || campaign_id || ':' || split_part(period, ':', 2) || ':' || account_id)
  OR (period ~ '^competition:[1-9][0-9]*:m[1-9][0-9]*$'
    AND reward_key = 'competition:' || campaign_id || ':' || split_part(period, ':', 2) || ':' || account_id || ':'
      || split_part(period, ':', 3))
  OR (period = 'distribution' AND reward_key = 'distribution:' || campaign_id || ':' || account_id)
  OR (period ~ '^pool:[1-9][0-9]*$'
    AND reward_key = 'pool:' || campaign_id || ':' || split_part(period, ':', 2) || ':' || account_id)
  OR (period ~ '^drop:[^:]+$' AND reward_key = 'drop:' || split_part(period, ':', 2) || ':' || account_id)
);

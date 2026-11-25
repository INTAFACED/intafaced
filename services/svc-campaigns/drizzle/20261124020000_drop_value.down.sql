-- Reverses 20261124020000_drop_value.sql. Refuses while any drop with value, claim of one or drop reward exists.

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
);

ALTER TABLE campaigns.drop_claims DROP CONSTRAINT IF EXISTS drop_claims_kind_ck;
ALTER TABLE campaigns.drop_claims ADD CONSTRAINT drop_claims_kind_ck CHECK (kind = 'entitlement');

ALTER TABLE campaigns.drops DROP CONSTRAINT IF EXISTS drops_kind_ck;
ALTER TABLE campaigns.drops DROP COLUMN IF EXISTS campaign_id;
ALTER TABLE campaigns.drops ADD CONSTRAINT drops_kind_ck CHECK (kind = 'entitlement');

ALTER TABLE campaigns.campaigns DROP CONSTRAINT IF EXISTS campaigns_type_ck;
ALTER TABLE campaigns.campaigns ADD CONSTRAINT campaigns_type_ck CHECK (type IN ('referral', 'task', 'voucher', 'competition',
  'milestone', 'draw', 'pool', 'distribution', 'trial_pass', 'gift_card', 'points', 'welcome'));

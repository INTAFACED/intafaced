-- intafaced:destructive reversal of 20261030210000_voucher_attempts.sql: drops the attempt log and the voucher key form
-- Refuses while a voucher redemption exists: the restored key rule would no longer hold for its intent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.reward_intents WHERE reward_key LIKE 'voucher:%') THEN
    RAISE EXCEPTION 'campaigns: a voucher redemption exists; its key form is never dropped by reversing this migration';
  END IF;
END $$;
DROP TABLE IF EXISTS campaigns.voucher_attempts;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_key_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_key_ck CHECK (
  reward_key = 'task:' || campaign_id || ':' || account_id || ':' || period);

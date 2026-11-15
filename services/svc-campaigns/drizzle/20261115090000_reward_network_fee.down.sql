-- Drops only what the chain's receipts already state: each fee can be read again from the payment's chain transaction.
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_network_fee_ck;
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS paid_network_fee_asset;
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS paid_network_fee;

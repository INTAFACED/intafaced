-- A reward payment's network fee, as the chain's receipt reports it (J-campaigns-02, launch money model): gas used times
-- its price, in the chain's own coin, paid by INTAFACED's wallet. It is our cost, never taken from the reward. Null when
-- the receipt did not say. Reversal: the matching .down.sql.
ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS paid_network_fee numeric(38, 18);
ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS paid_network_fee_asset text;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_network_fee_ck CHECK (
  (paid_network_fee IS NULL) = (paid_network_fee_asset IS NULL) AND (paid_network_fee IS NULL OR paid_network_fee >= 0));

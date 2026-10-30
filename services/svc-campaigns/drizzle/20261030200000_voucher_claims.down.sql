-- intafaced:destructive reversal of 20261030200000_voucher_claims.sql: drops the voucher claim columns and rebuilds the view
-- Refuses while a voucher is claimed: dropping its owner and use would silently lose who holds it and what was paid.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.vouchers WHERE claimed_by IS NOT NULL) THEN
    RAISE EXCEPTION 'campaigns: a voucher is claimed; voucher claims are never dropped by reversing this migration';
  END IF;
END $$;
DROP INDEX IF EXISTS campaigns.vouchers_use_by_idx;
DROP INDEX IF EXISTS campaigns.vouchers_owner_idx;
DROP INDEX IF EXISTS campaigns.vouchers_code_idx;
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_expired_ck;
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_claimed_ck;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS expired_at;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS claimed_at;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS claimed_by;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS use_by;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS claim_by;
DROP VIEW IF EXISTS campaigns.campaign_rows;
ALTER TABLE campaigns.campaigns DROP COLUMN IF EXISTS vouchers;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;

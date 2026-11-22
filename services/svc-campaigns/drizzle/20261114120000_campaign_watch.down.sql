-- Refuses while a code made in a batch or imported exists: it has no plain code, so code could not be NOT NULL again.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.vouchers WHERE batch_id IS NOT NULL) THEN
    RAISE EXCEPTION 'campaigns: a batch voucher exists; its plain code is not stored, so this migration is not reversed';
  END IF;
END $$;
DROP TABLE IF EXISTS campaigns.export_jobs;
DROP TABLE IF EXISTS campaigns.alert_settings;
DROP TABLE IF EXISTS campaigns.code_publications;
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_batch_fk;
DROP TABLE IF EXISTS campaigns.code_batches;
DROP INDEX IF EXISTS campaigns.vouchers_batch_idx;
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_deactivated_ck;
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_claimed_ck;
ALTER TABLE campaigns.vouchers ADD CONSTRAINT vouchers_claimed_ck CHECK (
  (state IN ('claimed', 'partially_used', 'used', 'expired')) = (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
);
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_code_form_ck;
DROP INDEX IF EXISTS campaigns.vouchers_code_hash_uq;
ALTER TABLE campaigns.vouchers ALTER COLUMN code SET NOT NULL;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS deactivated_at;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS deactivated_by;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS batch_id;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS code_last4;
ALTER TABLE campaigns.vouchers DROP COLUMN IF EXISTS code_hash;

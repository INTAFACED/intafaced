-- intafaced:destructive — reversal of 20261104123350_copy_pool_masters.sql
DROP TRIGGER IF EXISTS copy_pool_whitelist_imports_append_only ON trade.copy_pool_whitelist_imports;
DROP TABLE IF EXISTS trade.copy_pool_whitelist;
DROP TABLE IF EXISTS trade.copy_pool_whitelist_imports;
DROP TABLE IF EXISTS trade.copy_pools;
DELETE FROM trade.copy_lead_applications WHERE kind = 'pool_master';
DROP INDEX IF EXISTS trade.copy_lead_applications_open_kind_idx;
CREATE UNIQUE INDEX IF NOT EXISTS copy_lead_applications_open_idx
  ON trade.copy_lead_applications (user_id) WHERE status IN ('pending', 'awaiting_second');
ALTER TABLE trade.copy_lead_applications DROP CONSTRAINT IF EXISTS copy_lead_applications_approved_ck;
ALTER TABLE trade.copy_lead_applications ADD CONSTRAINT copy_lead_applications_approved_ck CHECK (
  status <> 'approved'
  OR (approver_id IS NOT NULL AND leader_ref IS NOT NULL AND lower(btrim(approver_id)) <> lower(btrim(proposed_by)))
);
ALTER TABLE trade.copy_lead_applications DROP CONSTRAINT IF EXISTS copy_lead_applications_kind_ck;
ALTER TABLE trade.copy_lead_applications DROP COLUMN IF EXISTS style;
ALTER TABLE trade.copy_lead_applications DROP COLUMN IF EXISTS contact;
ALTER TABLE trade.copy_lead_applications DROP COLUMN IF EXISTS kind;

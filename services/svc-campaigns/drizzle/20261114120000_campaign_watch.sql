-- intafaced:destructive drops NOT NULL on vouchers.code: a code made in a batch or imported is stored as its hash and last four characters only, so its plain code is null
-- J-campaigns-17, CM-campaign-types-03 and CM-campaign-admin-01, -02: code batches, voucher deactivation, the watch desk's
-- alert switches and exports.
--
-- Every voucher carries `code_hash` (SHA-256 of the upper-case code, hex) and `code_last4`; a customer's code is looked up
-- by its hash, and a hash is unique across campaigns, as a code was. A voucher issued one at a time by a founder keeps
-- its typed code too (J-campaigns-16 #9); a code made in a batch or imported is never stored in plain text anywhere.
ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS code_hash text;
ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS code_last4 text;
ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS batch_id text;
ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS deactivated_by text;
ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
UPDATE campaigns.vouchers SET code_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex'), code_last4 = right(code, 4)
WHERE code_hash IS NULL;
ALTER TABLE campaigns.vouchers ALTER COLUMN code_hash SET NOT NULL;
ALTER TABLE campaigns.vouchers ALTER COLUMN code_last4 SET NOT NULL;
ALTER TABLE campaigns.vouchers ALTER COLUMN code DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vouchers_code_hash_uq ON campaigns.vouchers (code_hash);
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_code_form_ck;
ALTER TABLE campaigns.vouchers ADD CONSTRAINT vouchers_code_form_ck CHECK (
  code_hash ~ '^[0-9a-f]{64}$' AND length(code_last4) = 4
  -- A batch's voucher never holds its plain code; a founder's typed one always does.
  AND (batch_id IS NULL) = (code IS NOT NULL)
);
-- A deactivated voucher may have been claimed or not; every other state keeps its rule.
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_claimed_ck;
ALTER TABLE campaigns.vouchers ADD CONSTRAINT vouchers_claimed_ck CHECK (
  state = 'deactivated'
  OR (state IN ('claimed', 'partially_used', 'used', 'expired')) = (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
);
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_deactivated_ck;
ALTER TABLE campaigns.vouchers ADD CONSTRAINT vouchers_deactivated_ck CHECK (
  (state = 'deactivated') = (deactivated_at IS NOT NULL AND deactivated_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS vouchers_batch_idx ON campaigns.vouchers (batch_id) WHERE batch_id IS NOT NULL;

-- A batch of codes, generated here or imported from an operator's CSV. Its reference is the business key with the
-- campaign: the same generate again returns the batch, never a second one (and never its codes again).
CREATE TABLE IF NOT EXISTS campaigns.code_batches (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  reference text NOT NULL,
  source text NOT NULL,
  count integer NOT NULL,
  state text NOT NULL DEFAULT 'generated',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_batches_reference_uq UNIQUE (campaign_id, reference),
  CONSTRAINT code_batches_source_ck CHECK (source IN ('generated', 'imported')),
  CONSTRAINT code_batches_count_ck CHECK (count > 0),
  CONSTRAINT code_batches_state_ck CHECK (state IN ('generated', 'published'))
);
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_batch_fk;
ALTER TABLE campaigns.vouchers ADD CONSTRAINT vouchers_batch_fk FOREIGN KEY (batch_id) REFERENCES campaigns.code_batches (id);

-- One row per batch published to customers: its vouchers moved from generated to published in the same transaction.
CREATE TABLE IF NOT EXISTS campaigns.code_publications (
  id text PRIMARY KEY,
  batch_id text NOT NULL UNIQUE REFERENCES campaigns.code_batches (id),
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  vouchers integer NOT NULL,
  published_by text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS code_publications_campaign_idx ON campaigns.code_publications (campaign_id, published_at DESC);

-- The watch desk's alert switches. The threshold is an owner value, never stored here; a blank one refuses to switch on.
CREATE TABLE IF NOT EXISTS campaigns.alert_settings (
  kind text PRIMARY KEY,
  enabled boolean NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_settings_kind_ck CHECK (kind IN ('budget_low', 'redemptions_spike'))
);

-- Exports. The same export (campaign, dataset and fields) asked for while its job is open or its link valid returns that
-- job, so one job runs. The file is deleted once its link expires.
CREATE TABLE IF NOT EXISTS campaigns.export_jobs (
  id text PRIMARY KEY,
  export_key text NOT NULL,
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  dataset text NOT NULL,
  fields text[] NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  validity_seconds integer NOT NULL,
  ready_at timestamptz,
  expires_at timestamptz,
  rows integer,
  file text,
  CONSTRAINT export_jobs_dataset_ck CHECK (dataset IN ('participants', 'redemptions', 'vouchers')),
  CONSTRAINT export_jobs_state_ck CHECK (state IN ('queued', 'running', 'ready', 'failed')),
  CONSTRAINT export_jobs_ready_ck CHECK ((state = 'ready') = (ready_at IS NOT NULL AND expires_at IS NOT NULL AND rows IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS export_jobs_key_idx ON campaigns.export_jobs (export_key, requested_at DESC);
CREATE INDEX IF NOT EXISTS export_jobs_campaign_idx ON campaigns.export_jobs (campaign_id, requested_at DESC);

-- Cost-basis choices for the profit and loss indicator (J-portfolio-04 steps 4 and 5).
-- Reversal: 20261024110000_cost_basis_choices.down.sql
--
-- The tax schema is created by the database bootstrap. This role does not create schemas.
-- The customer's own choices: a matching method for the account ('*') or one coin, one for a single UTC day, and which
-- lot a sale draws on first. Settings only: no balance, no amount. The lot book reads the ledger and applies these.
-- Every statement is idempotent, so the file is re-runnable.

CREATE TABLE IF NOT EXISTS tax.method_choices (
  user_id text NOT NULL,
  -- '*' is the whole account; otherwise the coin, e.g. BTC.
  asset_id text NOT NULL,
  method text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT method_choices_pk PRIMARY KEY (user_id, asset_id)
);

CREATE TABLE IF NOT EXISTS tax.method_days (
  user_id text NOT NULL,
  day date NOT NULL,
  -- '*' is every coin on that day.
  asset_id text NOT NULL,
  method text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT method_days_pk PRIMARY KEY (user_id, day, asset_id)
);

CREATE TABLE IF NOT EXISTS tax.lot_picks (
  user_id text NOT NULL,
  -- The ledger transaction of the sale, and the coin it sold.
  sale_tx_id text NOT NULL,
  asset_id text NOT NULL,
  -- `lot:<acquireTxId>:<assetId>`, the lot book's repeatable id.
  lot_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lot_picks_pk PRIMARY KEY (user_id, sale_tx_id, asset_id)
);

ALTER TABLE tax.method_choices DROP CONSTRAINT IF EXISTS method_choices_method_ck;
ALTER TABLE tax.method_choices ADD CONSTRAINT method_choices_method_ck CHECK (method IN ('FIFO', 'LIFO', 'HIFO', 'AVERAGE'));
ALTER TABLE tax.method_days DROP CONSTRAINT IF EXISTS method_days_method_ck;
ALTER TABLE tax.method_days ADD CONSTRAINT method_days_method_ck CHECK (method IN ('FIFO', 'LIFO', 'HIFO', 'AVERAGE'));

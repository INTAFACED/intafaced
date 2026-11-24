-- trade.copy_settled_fee_shares on the venue, and trade.copy_fee_share_funds (J-copy-bots-otc-06 #1 #3; launch money model)
-- Reversal: 20261120140000_copy_venue_fee_shares.down.sql
--
-- A copy placed on the follower's own venue sub-account (src/copy/venue-copy.ts) earns our builder fee on its fills. The
-- lead's share of that fee is our own liability to the lead (ledger-client `feeShareOwe`, from the venue's fee-share budget
-- that `feeShareBudgetFund` sets aside from a collected claim). src/copy/venue-fee-share.ts records one row per venue fill
-- here, before anything is posted, and the columns below say which fill it is and how far it has come:
-- - venue_id, venue_account, venue_fill_id: the fill our builder fee was earned on, as the venue names it (the earn key's
--   parts, `builder-fee:<venue_id>:<venue_account>:<venue_fill_id>`); leader_fill_id: the lead's fill the copy was made for;
--   filled_at: the venue's time of the fill.
-- - claim_id: the venue claim whose set-aside funds this share (trade.copy_fee_share_funds), once planned.
-- - owe_tx_id: the ledger transaction the share was owed under, once posted (settled = true).
-- A row of the TEST book's path keeps these null. Nothing here is a balance: the ledger is the record of what is owed.
--
-- trade.copy_fee_share_funds is one set-aside per venue claim, planned (its amount and the rows it covers fixed) before it
-- is posted, so a retry after a crash posts the same body under the same key.

ALTER TABLE trade.copy_settled_fee_shares ADD COLUMN IF NOT EXISTS venue_id text;
ALTER TABLE trade.copy_settled_fee_shares ADD COLUMN IF NOT EXISTS venue_account text;
ALTER TABLE trade.copy_settled_fee_shares ADD COLUMN IF NOT EXISTS venue_fill_id text;
ALTER TABLE trade.copy_settled_fee_shares ADD COLUMN IF NOT EXISTS leader_fill_id text;
ALTER TABLE trade.copy_settled_fee_shares ADD COLUMN IF NOT EXISTS filled_at timestamptz;
ALTER TABLE trade.copy_settled_fee_shares ADD COLUMN IF NOT EXISTS claim_id text;
ALTER TABLE trade.copy_settled_fee_shares ADD COLUMN IF NOT EXISTS owe_tx_id text;
ALTER TABLE trade.copy_settled_fee_shares DROP CONSTRAINT IF EXISTS copy_settled_fee_shares_venue_ck;
ALTER TABLE trade.copy_settled_fee_shares ADD CONSTRAINT copy_settled_fee_shares_venue_ck CHECK (
  (venue_id IS NULL AND venue_account IS NULL AND venue_fill_id IS NULL AND leader_fill_id IS NULL AND filled_at IS NULL
     AND claim_id IS NULL AND owe_tx_id IS NULL)
  OR (venue_id IS NOT NULL AND venue_account IS NOT NULL AND venue_fill_id IS NOT NULL AND leader_fill_id IS NOT NULL
     AND filled_at IS NOT NULL AND (settled = false OR (claim_id IS NOT NULL AND owe_tx_id IS NOT NULL)))
);
CREATE INDEX IF NOT EXISTS copy_settled_fee_shares_venue_idx
  ON trade.copy_settled_fee_shares (venue_id, asset_id, filled_at) WHERE venue_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS trade.copy_fee_share_funds (
  venue_id     text NOT NULL,
  claim_id     text NOT NULL,
  asset_id     text NOT NULL,
  claim_amount numeric(38, 18) NOT NULL CONSTRAINT copy_fee_share_funds_claim_ck CHECK (claim_amount > 0),
  amount       numeric(38, 18) NOT NULL CONSTRAINT copy_fee_share_funds_amount_ck CHECK (amount > 0 AND amount <= claim_amount),
  status       text NOT NULL CONSTRAINT copy_fee_share_funds_status_ck CHECK (status IN ('planned', 'posted')),
  ledger_tx_id text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, claim_id),
  CONSTRAINT copy_fee_share_funds_posted_ck CHECK ((status = 'posted') = (ledger_tx_id IS NOT NULL))
);

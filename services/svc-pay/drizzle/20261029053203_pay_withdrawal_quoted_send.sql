-- J-wallet-05 #6 (issue #6517): a withdrawal to a wallet outside the platform names the network it is sent on and the fee
-- quote the person accepted, and keeps the quoted fee, so every step after the claim (hold, settle, a refusal's reverse, a
-- cancel, a dropped send's reverse, and any retry or crash recovery) posts that same fee from the row and never asks again.
-- The ledger's hold is the amount plus the fee; what leaves the balance is the quote's total debit.
--
-- All three are NULL on every earlier row and on a send inside the platform (W-withdraw-14), which carries no fee: those
-- withdrawals post exactly as before. A quoted send has all three. One quote pays for one withdrawal.
-- Reversal: 20261029053203_pay_withdrawal_quoted_send.down.sql

ALTER TABLE pay.withdrawals ADD COLUMN network_id text;
ALTER TABLE pay.withdrawals ADD COLUMN quote_ref text;
ALTER TABLE pay.withdrawals ADD COLUMN fee numeric(38, 18);

ALTER TABLE pay.withdrawals ADD CONSTRAINT withdrawals_quoted_send_ck CHECK (
  (quote_ref IS NULL AND fee IS NULL AND network_id IS NULL)
  OR (quote_ref IS NOT NULL AND fee IS NOT NULL AND network_id IS NOT NULL
      AND fee >= 0 AND length(btrim(quote_ref)) > 0 AND length(btrim(network_id)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_quote_ref_idx ON pay.withdrawals (user_id, quote_ref) WHERE quote_ref IS NOT NULL;

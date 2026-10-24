-- W-withdraw-07: a held withdrawal may be cancelled only when its dispatch journal proves nothing was sent.
-- `withdraw` sets this column to true on the move into `held`, and that code writes the attempt's `requested` journal row
-- before it asks the rail. So a held row marked true with no journal row for its attempt was never sent.
-- A row held before this column existed stays NULL: its dispatch history is unknown, and it is never cancelled.
-- Reversal: 20261024185537_pay_withdrawal_dispatch_journaled.down.sql

ALTER TABLE pay.withdrawals ADD COLUMN dispatch_journaled boolean;

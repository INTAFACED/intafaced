-- Reverses 20261030021248_pay_withdrawal_send_depth.sql. The column is a receipt of the depth last read, not a balance: dropping it
-- shows every accepted send as `broadcast` until it settles, as before.

ALTER TABLE pay.withdrawal_rail_attempts DROP COLUMN IF EXISTS confirmations;

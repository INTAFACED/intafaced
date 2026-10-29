-- intafaced:destructive — reversal of 20261029053203_pay_withdrawal_quoted_send.sql
-- Dropping the columns forgets which network and quote a send used and the fee its hold carries. Run it only while no
-- quoted withdrawal is pending or held: such a row would resume without its fee, and svc-ledger refuses a settle or reverse
-- whose fee is not its hold's, so the hold would stay until the columns came back.

DROP INDEX IF EXISTS pay.withdrawals_quote_ref_idx;
ALTER TABLE pay.withdrawals DROP CONSTRAINT IF EXISTS withdrawals_quoted_send_ck;
ALTER TABLE pay.withdrawals DROP COLUMN IF EXISTS fee;
ALTER TABLE pay.withdrawals DROP COLUMN IF EXISTS quote_ref;
ALTER TABLE pay.withdrawals DROP COLUMN IF EXISTS network_id;

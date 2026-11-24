-- What one personal send cost, recorded once when it is reserved (J-pay-01 #8: "the activity row shows state, date and
-- fees"): our own fee, which is the published fee the send was checked against (a send is refused while a fee above zero
-- is published, so it is 0 today), and the network fee as the book that moves it stated it at that moment ("0" on our own
-- book, which crosses no network; the partner bank's stated send fee for money it holds; NULL when the partner gave none,
-- read as "not known"). A send recorded before this column existed keeps NULL in both: its fees were not recorded.
--
-- Reversal: 20261123222718_personal_transfer_fees.down.sql

ALTER TABLE "bank"."personal_transfers" ADD COLUMN IF NOT EXISTS "fee" numeric(38, 18);
ALTER TABLE "bank"."personal_transfers" ADD COLUMN IF NOT EXISTS "network_fee" numeric(38, 18);

COMMENT ON COLUMN "bank"."personal_transfers"."fee" IS 'money: a RECORD of our fee on one personal send, as published when it was sent; written once, never summed';
COMMENT ON COLUMN "bank"."personal_transfers"."network_fee" IS 'money: a RECORD of the network fee the moving book stated for one personal send; written once, never summed';

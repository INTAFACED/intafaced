-- The scam warning on a first-time payee (BK-safe-02, J-bank-18 #2): when the person read it for this recipient.
--
-- Null until they read it: the transfer review shows the warning for that recipient until then, and never again after.
-- One warning per recipient row, so a changed account (a new row) is a first-time payee again. Nothing is held or posted.
--
-- Reversal: 20261109094904_rail_payees_scam_warning.down.sql

ALTER TABLE "bank"."rail_payees" ADD COLUMN IF NOT EXISTS "scam_warning_read_at" timestamptz;

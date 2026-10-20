-- Reverses 0061_account_self_freezes.sql. Freeze history is dropped; no account is frozen by it afterwards.
DROP TABLE IF EXISTS "identity"."account_self_freezes";

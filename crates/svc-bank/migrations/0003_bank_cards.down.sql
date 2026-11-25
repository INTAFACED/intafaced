-- Reversal of 0003_bank_cards.
--
-- intafaced:destructive — dropping these tables destroys the card audit trail:
-- every authorisation decision and the named reason for each decline, every
-- capture and reversal, every cashback payment and every cashback that could not
-- be paid. The LEDGER keeps the money history regardless (that is the point of
-- §0.6), so no value is lost and no balance changes. What is lost is the ability
-- to answer "why was this declined" and "which purchase was this hold for".
--
-- So: this reversal is for an unwind on a branch. Rolling it back on a database
-- with authorisations in it is an operator decision that needs the tables
-- exported first, and there is no version of it that is routine.
--
-- `bank.loan_event_status` is NOT dropped here — 0002 owns it and the loan
-- tables still use it. A reversal that dropped a type it borrowed would take the
-- loans schema down with it.

DROP TABLE IF EXISTS "bank"."card_cashback";
DROP TABLE IF EXISTS "bank"."card_settlements";
DROP TABLE IF EXISTS "bank"."card_authorizations";
DROP TABLE IF EXISTS "bank"."cards";

DROP TYPE IF EXISTS "bank"."card_settlement_kind";
DROP TYPE IF EXISTS "bank"."card_decision";
DROP TYPE IF EXISTS "bank"."card_status";

-- intafaced:destructive deletes only a published KYB upload rule whose max_bytes the transport cannot carry; not money.
--
-- UNPUBLISH A KYB UPLOAD RULE THAT CANNOT FIT THROUGH THE HTTP BODY LIMITS, BEFORE THE CAP IS ADDED.
--
-- `20261117184554_pay_kyb_upload_rules_fit_transport.sql` adds CHECK ("max_bytes" <= 716800). On a database that
-- already holds a rule above that (a local test stack seeded before the cap, which seeded 1 MiB), Postgres refuses
-- the constraint and svc-pay's migrations stop, so the stack never starts (#8796). This file is stamped one second
-- earlier on purpose so it runs first there; a database that already ran the cap holds no such row and this deletes
-- nothing.
--
-- The rule is removed, not lowered: max_bytes is the owner's value, and inventing a smaller one would publish a rule
-- nobody set. With no row the rules are unpublished, uploads refuse with `pay.kyb_upload_rules_unset`, and the
-- owner (or the stack's TEST seed) publishes a rule within the cap again. Not money.

DELETE FROM "pay"."kyb_upload_rules" WHERE "max_bytes" > 716800;

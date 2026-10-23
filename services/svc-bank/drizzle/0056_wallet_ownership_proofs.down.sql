-- intafaced:destructive drops every private-wallet ownership proof; saved addresses stay, unproved
DROP INDEX IF EXISTS "bank"."wallet_ownership_proofs_entry_idx";
DROP TABLE IF EXISTS "bank"."wallet_ownership_proofs";

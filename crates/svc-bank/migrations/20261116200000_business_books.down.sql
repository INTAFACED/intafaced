-- Reverses 20261116200000_business_books.sql. These tables hold only the business's own bookkeeping about the partner's
-- lines (categories, GL codes, rules) and the record of an accounting connection asked for: no instruction, no amount and
-- nothing the partner carried out, so dropping them loses no record of money.

-- intafaced:destructive the business bookkeeping tables this migration added, which hold no money record
DROP TABLE IF EXISTS "bank"."business_line_codes";
DROP TABLE IF EXISTS "bank"."business_coding_rules";
DROP TABLE IF EXISTS "bank"."business_accounting_connections";

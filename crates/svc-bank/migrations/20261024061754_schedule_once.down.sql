-- Cannot remove enum values safely in Postgres; leave 'once' in place.
--
-- Same reversal as 0005's: `ALTER TYPE … DROP VALUE` does not exist, and rewriting the type would rewrite every row
-- that references it. Rolling back the code is enough: nothing writes 'once' without it, and a one-off already run is a
-- true record of a payment that was made.
SELECT 1;

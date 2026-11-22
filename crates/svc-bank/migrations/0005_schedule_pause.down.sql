-- Cannot remove enum values safely in Postgres; leave 'skipped' in place.
--
-- Same reversal as 0001's, and for the same reason: `ALTER TYPE … DROP VALUE`
-- does not exist, and rewriting the type would rewrite every row that references
-- it. Rolling back the code is enough — nothing writes 'skipped' once
-- `resumeSchedule` is gone, and the rows already written are a true record of
-- occurrences that did not fire, which a rollback has no business deleting.
SELECT 1;

-- Only a TEST listing may keep the TEST schedule (20261118020100): a real market never trades on hours no venue keeps.
ALTER TABLE trade.markets DROP CONSTRAINT IF EXISTS markets_test_schedule_only_test_ck;
ALTER TABLE trade.markets
  ADD CONSTRAINT markets_test_schedule_only_test_ck CHECK (schedule::text <> 'test-sunday-minute' OR "test" = true);

-- intafaced:destructive — reversal of 20261112160000_academy_report_centre.sql
-- Drops every report task, its stored file and its history, and the recording start of the daily activity table.
DROP TABLE IF EXISTS "academy"."report_centre_events";
DROP TABLE IF EXISTS "academy"."report_centre_tasks";
DROP TABLE IF EXISTS "academy"."metrics_recording";

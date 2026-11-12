-- intafaced:destructive — reversal of 20261112123831_academy_reports.sql
-- Drops every report task, its stored file and its history, and the recording start of the daily activity table.
DROP TABLE IF EXISTS "academy"."report_task_events";
DROP TABLE IF EXISTS "academy"."report_tasks";
DROP TABLE IF EXISTS "academy"."metrics_recording";

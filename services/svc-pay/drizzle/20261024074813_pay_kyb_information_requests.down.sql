-- intafaced:destructive — reversal of 20261024074813_pay_kyb_information_requests.sql
--
-- Drops every information request, its answer and file, and its history.

DROP TRIGGER IF EXISTS "kyb_information_requests_forward_only_trg" ON "pay"."kyb_information_requests";
DROP FUNCTION IF EXISTS "pay"."kyb_information_requests_forward_only"();
DROP TRIGGER IF EXISTS "kyb_request_events_append_only_trg" ON "pay"."kyb_request_events";
DROP TRIGGER IF EXISTS "kyb_request_answers_append_only_trg" ON "pay"."kyb_request_answers";
DROP FUNCTION IF EXISTS "pay"."kyb_request_append_only"();
DROP TABLE IF EXISTS "pay"."kyb_request_events";
DROP TABLE IF EXISTS "pay"."kyb_request_answers";
DROP TABLE IF EXISTS "pay"."kyb_information_requests";

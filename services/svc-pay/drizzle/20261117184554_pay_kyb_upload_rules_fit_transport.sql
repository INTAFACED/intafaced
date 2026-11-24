-- KYB UPLOAD RULES MUST FIT THROUGH THE HTTP BODY LIMITS.
--
-- A KYB file travels as base64 inside one JSON request, so the body is about a third larger than the file. The front
-- door (`EDGE_BODY_LIMIT_BYTES`, 1 MiB on the stack) and svc-pay (Fastify's 1 MiB default) refuse a larger body with a
-- 413 before the upload rules are read. A published `max_bytes` above 716 800 (700 KiB: 955 734 base64 characters,
-- leaving room for the request envelope under 1 MiB) would let the portal accept a file the transport then refuses.
-- Publishing such a rule now refuses here instead. Raising it needs both body limits raised first. Not money.

ALTER TABLE "pay"."kyb_upload_rules"
  ADD CONSTRAINT "kyb_upload_rules_max_bytes_fits_transport" CHECK ("max_bytes" <= 716800);

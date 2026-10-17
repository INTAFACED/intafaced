DROP TRIGGER IF EXISTS notice_published_immutable ON notify.notices;
DROP FUNCTION IF EXISTS notify.notice_published_immutable();
DROP TABLE IF EXISTS "notify"."notice_approval_uses";
DROP TABLE IF EXISTS "notify"."notices";

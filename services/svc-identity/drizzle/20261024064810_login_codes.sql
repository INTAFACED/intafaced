-- svc-identity · sign-in by a mailed code (I-signin-sessions-19, I-signin-sessions-20). Reversal: the .down.sql of the same name.
--
-- A code sign-in is an `auth_flows` row of kind `login_code` plus one `mail_outbox` row per code sent. Every name
-- does the same work: an active account's flow is `code_sent` and its job (`login-code`) carries a six-digit code to
-- the account's own address; an unknown name, or a frozen or closed account, gets a `suppressed` flow whose code hash
-- is of a value nobody holds, and a `login-no-account` job that stays unsent unless the owner turned recovery notices
-- on and the name is an email address. No new table; only the two allow-lists grow.
ALTER TABLE "identity"."auth_flows" DROP CONSTRAINT IF EXISTS "auth_flows_kind_check";
ALTER TABLE "identity"."auth_flows"
  ADD CONSTRAINT "auth_flows_kind_check" CHECK ("kind" IN ('password_reset', 'handle_recovery', 'signup', 'login_code'));

ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account'
  ));

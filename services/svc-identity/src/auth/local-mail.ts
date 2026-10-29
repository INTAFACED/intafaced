import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { MailPurpose, PasswordResetMail } from './password-reset.js';

/**
 * The only mail transport this service implements. It writes a LOCAL-TEST line
 * to a file on this machine. Staging and production stay unwired: selecting
 * this transport outside APP_ENV exactly `dev` or `test` refuses at boot, and
 * any other transport name refuses at boot. No outside provider is configured.
 *
 * The confirm link is in the file. The console line names the purpose and
 * does not include the token.
 */

export const LOCAL_MAIL_TRANSPORT = 'local-outbox';
export const MAIL_TRANSPORT_REFUSED = 'auth.mail_transport_refused';

export interface IdentityMailBoot {
  /** Raw APP_ENV. Unset is not dev: the schema default must not open this door. */
  readonly appEnv: string | undefined;
  readonly transport: string | undefined;
  readonly outboxPath: string | undefined;
}

export function openIdentityMail(input: IdentityMailBoot): PasswordResetMail | undefined {
  const transport = input.transport?.trim() ?? '';
  if (transport === '') return undefined;
  if (transport !== LOCAL_MAIL_TRANSPORT) {
    throw new Error(`${MAIL_TRANSPORT_REFUSED}: mail transport is not available`);
  }
  if (input.appEnv !== 'dev' && input.appEnv !== 'test') {
    throw new Error(`${MAIL_TRANSPORT_REFUSED}: local-outbox is allowed only when APP_ENV is exactly dev or test`);
  }
  const outboxPath = input.outboxPath?.trim() ?? '';
  if (!outboxPath || !path.isAbsolute(outboxPath)) {
    throw new Error(`${MAIL_TRANSPORT_REFUSED}: IDENTITY_LOCAL_MAIL_OUTBOX must be an absolute file path`);
  }
  return createLocalOutboxMail(outboxPath);
}

type LocalMailMessage = Parameters<PasswordResetMail['send']>[0];

/** One LOCAL-TEST line. `code` is the secret and is placed only in `link`. */
export function localMailLine(message: LocalMailMessage): string {
  // The anti-phishing code goes on the end of the line it rides on; letters and digits only, by its own rule.
  const stamp = message.antiPhishingCode ? ` anti_phishing=${message.antiPhishingCode.replace(/[^A-Za-z0-9]/g, '')}` : '';
  // A security notice's "this was not me" link (freeze-link.ts) rides on the notice line, before the stamp.
  const freeze = message.freezeToken ? ` freeze=freeze/confirm#token=${encodeURIComponent(message.freezeToken)}` : '';
  return localMailBody(message).replace(/\n$/, `${freeze}${stamp}\n`);
}

function localMailBody(message: LocalMailMessage): string {
  const purpose = message.purpose ?? 'password-reset';
  const email = message.email.replace(/\s+/g, '');
  if (purpose === 'password-changed') {
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} notice=password-changed\n`;
  }
  if (purpose === 'mfa-reset-started') {
    // The notice every contact gets while a second-step reset waits; `until` is when it would complete.
    return `LOCAL-TEST purpose=${purpose} email=${email} until=${message.expiresAt.toISOString()} notice=mfa-reset-started\n`;
  }
  if (purpose === 'factor-changed') {
    // What changed rides in `detail` (totp_added, passkey_removed, ...); never a secret or a credential id.
    const change = (message.detail ?? '').replace(/[^a-z_]/g, '');
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} notice=factor-changed change=${change}\n`;
  }
  if (purpose === 'support-recovery') {
    // The one-time link Support's case sends (I-signin-sessions-24). Only the person's own mailbox ever holds it.
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} link=recover-account?token=${encodeURIComponent(message.code)}\n`;
  }
  if (purpose === 'mfa-reset-cancelled' || purpose === 'mfa-reset-completed' || purpose === 'support-recovery-used') {
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} notice=${purpose}\n`;
  }
  if (purpose === 'email-change-notice') {
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} notice=address-changed\n`;
  }
  if (purpose === 'reset-no-account' || purpose === 'handle-recovery-no-account' || purpose === 'login-no-account') {
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} notice=no-account\n`;
  }
  if (purpose === 'signup-existing') {
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} notice=already-registered\n`;
  }
  if (purpose === 'signup-code' || purpose === 'login-code' || purpose === 'new-device-code' || purpose === 'mfa-reset-code') {
    // A six-digit code the person types, not a link.
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} code=${message.code.replace(/\D/g, '')}\n`;
  }
  if (purpose === 'handle-recovery') {
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} handle=${(message.handle ?? '').replace(/\s+/g, '')}\n`;
  }
  if (purpose === 'withdraw-address-approval') {
    // The detail is a plain line; spaces become underscores so the line stays one field per word.
    const detail = (message.detail ?? '').replace(/[^A-Za-z0-9.:,()_-]+/g, '_');
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} detail=${detail} link=approveAddress?token=${encodeURIComponent(message.code)}\n`;
  }
  const link =
    purpose === 'email-confirm'
      ? `confirm-email?token=${encodeURIComponent(message.code)}`
      : purpose === 'email-change'
        ? `changeEmail?code=${encodeURIComponent(message.code)}`
        : `completePasswordReset?code=${encodeURIComponent(message.code)}`;
  return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} link=${link}\n`;
}

export function createLocalOutboxMail(filePath: string): PasswordResetMail {
  return {
    async send(message) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, localMailLine(message), { mode: 0o600 });
      process.stderr.write(`LOCAL-TEST mail written purpose=${message.purpose ?? 'password-reset'}\n`);
    },
  };
}

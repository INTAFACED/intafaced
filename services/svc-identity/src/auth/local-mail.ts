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

/** One LOCAL-TEST line. `code` is the secret and is placed only in `link`. */
export function localMailLine(message: {
  readonly email: string;
  readonly code: string;
  readonly expiresAt: Date;
  readonly purpose?: MailPurpose;
  readonly handle?: string;
}): string {
  const purpose = message.purpose ?? 'password-reset';
  const email = message.email.replace(/\s+/g, '');
  if (purpose === 'email-change-notice') {
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} notice=address-changed\n`;
  }
  if (purpose === 'reset-no-account' || purpose === 'handle-recovery-no-account') {
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} notice=no-account\n`;
  }
  if (purpose === 'signup-existing') {
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} notice=already-registered\n`;
  }
  if (purpose === 'signup-code') {
    // A six-digit code the person types, not a link.
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} code=${message.code.replace(/\D/g, '')}\n`;
  }
  if (purpose === 'handle-recovery') {
    return `LOCAL-TEST purpose=${purpose} email=${email} expires=${message.expiresAt.toISOString()} handle=${(message.handle ?? '').replace(/\s+/g, '')}\n`;
  }
  const link =
    purpose === 'email-confirm'
      ? `confirmEmail?token=${encodeURIComponent(message.code)}`
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

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The only text-message transport this service implements. Like the mail one (local-mail.ts) it writes a LOCAL-TEST
 * line to a file on this machine and texts nobody: selecting it outside APP_ENV exactly `dev` or `test` refuses at boot,
 * and any other transport name refuses at boot. With none selected, texted codes answer `vendor.sms`. No outside SMS
 * provider is configured.
 *
 * The code is in the file. The console line names the purpose and does not include the code or the number.
 */

export const LOCAL_SMS_TRANSPORT = 'local-outbox';
export const SMS_TRANSPORT_REFUSED = 'auth.sms_transport_refused';

export type SmsPurpose = 'phone-signin-link';

export type SmsTransport = {
  send(message: { readonly phone: string; readonly code: string; readonly expiresAt: Date; readonly purpose: SmsPurpose }): Promise<void>;
};

export interface IdentitySmsBoot {
  /** Raw APP_ENV. Unset is not dev. */
  readonly appEnv: string | undefined;
  readonly transport: string | undefined;
  readonly outboxPath: string | undefined;
}

export function openIdentitySms(input: IdentitySmsBoot): SmsTransport | undefined {
  const transport = input.transport?.trim() ?? '';
  if (transport === '') return undefined;
  if (transport !== LOCAL_SMS_TRANSPORT) throw new Error(`${SMS_TRANSPORT_REFUSED}: text-message transport is not available`);
  if (input.appEnv !== 'dev' && input.appEnv !== 'test') {
    throw new Error(`${SMS_TRANSPORT_REFUSED}: local-outbox is allowed only when APP_ENV is exactly dev or test`);
  }
  const outboxPath = input.outboxPath?.trim() ?? '';
  if (!outboxPath || !path.isAbsolute(outboxPath)) {
    throw new Error(`${SMS_TRANSPORT_REFUSED}: IDENTITY_LOCAL_SMS_OUTBOX must be an absolute file path`);
  }
  return createLocalOutboxSms(outboxPath);
}

/** One LOCAL-TEST line: the purpose, the number, when the code runs out, and the six digits the person would read. */
export function localSmsLine(message: Parameters<SmsTransport['send']>[0]): string {
  const phone = message.phone.replace(/[^+0-9]/g, '');
  return `LOCAL-TEST purpose=${message.purpose} phone=${phone} expires=${message.expiresAt.toISOString()} code=${message.code.replace(/\D/g, '')}\n`;
}

export function createLocalOutboxSms(filePath: string): SmsTransport {
  return {
    async send(message) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, localSmsLine(message), { mode: 0o600 });
      process.stderr.write(`LOCAL-TEST text written purpose=${message.purpose}\n`);
    },
  };
}

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { PasswordResetMail } from './password-reset.js';
import { GATEWAY_MAIL_TRANSPORT, MailTransportRefused, openGatewayMail, type GatewayMailSettings } from './gateway-mail.js';

/**
 * Two mail transports. `local-outbox` writes a LOCAL-TEST line to a file on this machine, and refuses at boot outside
 * APP_ENV exactly `dev` or `test`; the confirm link is in the file, and the console line names the purpose without the
 * token. `http-gateway` (`gateway-mail.ts`) hands each mail to the operator's mail gateway, in any environment, and
 * refuses at boot when one of its settings is missing. Any other name refuses at boot.
 *
 * Unset, a dev or test stack runs without mail (its mail flows refuse), but a `staging` or `prod` start refuses: a
 * hosted stack without mail cannot send a sign-up code, so it must not come up looking healthy.
 */

export const LOCAL_MAIL_TRANSPORT = 'local-outbox';
export const MAIL_TRANSPORT_REFUSED = 'auth.mail_transport_refused';

export interface IdentityMailBoot {
  /** Raw APP_ENV. Unset is not dev: the schema default must not open this door. */
  readonly appEnv: string | undefined;
  readonly transport: string | undefined;
  readonly outboxPath: string | undefined;
  /** The gateway's settings; read only when the transport is `http-gateway`. */
  readonly gateway?: GatewayMailSettings | undefined;
}

export function openIdentityMail(input: IdentityMailBoot, fetchImpl?: typeof fetch): PasswordResetMail | undefined {
  const transport = input.transport?.trim() ?? '';
  if (transport === '') {
    if (input.appEnv === 'staging' || input.appEnv === 'prod' || input.appEnv === 'production') {
      throw new MailTransportRefused('IDENTITY_MAIL_TRANSPORT', `must be ${GATEWAY_MAIL_TRANSPORT} when APP_ENV is ${input.appEnv}`);
    }
    return undefined;
  }
  if (transport === GATEWAY_MAIL_TRANSPORT) {
    const none = { url: undefined, key: undefined, from: undefined, linkBase: undefined, consoleLinkBase: undefined };
    return openGatewayMail(input.gateway ?? none, input.appEnv, fetchImpl);
  }
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

/**
 * One LOCAL-TEST line. `code` is the secret and is placed only in `link`; the confirmation mail's six-digit `pin` (also
 * a secret) is its `code=` field, as the person would read it.
 */
export function localMailLine(message: LocalMailMessage): string {
  // The anti-phishing code goes on the end of the line it rides on; letters and digits only, by its own rule.
  const stamp = message.antiPhishingCode ? ` anti_phishing=${message.antiPhishingCode.replace(/[^A-Za-z0-9]/g, '')}` : '';
  // A security notice's "this was not me" link (freeze-link.ts) rides on the notice line, before the stamp.
  const freeze = message.freezeToken ? ` freeze=freeze/confirm#token=${encodeURIComponent(message.freezeToken)}` : '';
  const purpose = message.purpose ?? 'password-reset';
  const email = message.email.replace(/\s+/g, '');
  return `LOCAL-TEST purpose=${purpose} email=${email} ${mailFieldText(message)}${freeze}${stamp}\n`;
}

/**
 * What a mail says, as ordered `name=value` pairs: the same fields the LOCAL-TEST line carries after `email=`, freeze
 * link and anti-phishing code included. `link` and `freeze` are paths relative to the customer app (the staff invite's to
 * the console). Values hold no spaces. The gateway transport (`gateway-mail.ts`) writes its mail from these.
 */
export function mailFields(message: LocalMailMessage): ReadonlyArray<readonly [string, string]> {
  const line = localMailLine(message).trimEnd();
  return line
    .split(' ')
    .slice(3)
    .map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)] as const;
    });
}

function mailFieldText(message: LocalMailMessage): string {
  const purpose = message.purpose ?? 'password-reset';
  if (purpose === 'password-changed') {
    return `expires=${message.expiresAt.toISOString()} notice=password-changed`;
  }
  if (purpose === 'mfa-reset-started') {
    // The notice every contact gets while a second-step reset waits; `until` is when it would complete.
    return `until=${message.expiresAt.toISOString()} notice=mfa-reset-started`;
  }
  if (purpose === 'factor-changed') {
    // What changed rides in `detail` (totp_added, passkey_removed, ...); never a secret or a credential id.
    const change = (message.detail ?? '').replace(/[^a-z_]/g, '');
    return `expires=${message.expiresAt.toISOString()} notice=factor-changed change=${change}`;
  }
  if (purpose === 'support-recovery') {
    // The one-time link Support's case sends (I-signin-sessions-24). Only the person's own mailbox ever holds it.
    return `expires=${message.expiresAt.toISOString()} link=recover-account?token=${encodeURIComponent(message.code)}`;
  }
  if (purpose === 'mfa-reset-cancelled' || purpose === 'mfa-reset-completed' || purpose === 'support-recovery-used') {
    return `expires=${message.expiresAt.toISOString()} notice=${purpose}`;
  }
  if (purpose === 'appeal-decided') {
    // The outcome only (lifted or upheld); the reason's words are on the account status page.
    const outcome = (message.detail ?? '').replace(/[^a-z]/g, '');
    return `expires=${message.expiresAt.toISOString()} notice=appeal-decided outcome=${outcome}`;
  }
  if (purpose === 'email-change-notice') {
    return `expires=${message.expiresAt.toISOString()} notice=address-changed`;
  }
  if (purpose === 'reset-no-account' || purpose === 'handle-recovery-no-account' || purpose === 'login-no-account') {
    return `expires=${message.expiresAt.toISOString()} notice=no-account`;
  }
  if (purpose === 'signup-existing') {
    return `expires=${message.expiresAt.toISOString()} notice=already-registered`;
  }
  if (
    purpose === 'signup-code' ||
    purpose === 'login-code' ||
    purpose === 'new-device-code' ||
    purpose === 'mfa-reset-code' ||
    purpose === 'receive-contact-code'
  ) {
    // A six-digit code the person types, not a link.
    return `expires=${message.expiresAt.toISOString()} code=${message.code.replace(/\D/g, '')}`;
  }
  if (purpose === 'handle-recovery') {
    return `expires=${message.expiresAt.toISOString()} handle=${(message.handle ?? '').replace(/\s+/g, '')}`;
  }
  if (purpose === 'staff-invite') {
    // The console's first-connection page, relative to the console as the customer links are to the app.
    return `expires=${message.expiresAt.toISOString()} link=staff-welcome?token=${encodeURIComponent(message.code)}`;
  }
  if (purpose === 'support-chat-email') {
    // A support chat continued by email (J-support-public-05 #7): the mail names the chat, and its link opens the app's
    // support chat.
    // `part` is what this mail adds to the thread: the chat itself, or an agent's reply by its number.
    const chat = message.code.replace(/[^A-Za-z0-9-]/g, '');
    const part = (message.detail ?? '').replace(/[^A-Za-z0-9]+/g, '_');
    return `expires=${message.expiresAt.toISOString()} chat=${chat} part=${part} link=support/chat`;
  }
  if (purpose === 'withdraw-address-approval') {
    // The detail is a plain line; spaces become underscores so the line stays one field per word.
    const detail = (message.detail ?? '').replace(/[^A-Za-z0-9.:,()_-]+/g, '_');
    return `expires=${message.expiresAt.toISOString()} detail=${detail} link=approveAddress?token=${encodeURIComponent(message.code)}`;
  }
  const link =
    purpose === 'email-confirm'
      ? `confirm-email?token=${encodeURIComponent(message.code)}`
      : purpose === 'email-change'
        ? `changeEmail?code=${encodeURIComponent(message.code)}`
        : `completePasswordReset?code=${encodeURIComponent(message.code)}`;
  // The confirmation mail carries a six-digit code to type on Account beside its link.
  const pin = purpose === 'email-confirm' && message.pin ? ` code=${message.pin.replace(/\D/g, '')}` : '';
  return `expires=${message.expiresAt.toISOString()}${pin} link=${link}`;
}

function createLocalOutboxMail(filePath: string): PasswordResetMail {
  return {
    async send(message) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, localMailLine(message), { mode: 0o600 });
      process.stderr.write(`LOCAL-TEST mail written purpose=${message.purpose ?? 'password-reset'}\n`);
    },
  };
}

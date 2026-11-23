import type { PasswordResetMail } from './password-reset.js';
import { mailFields } from './local-mail.js';

/**
 * The mail transport for a hosted stack: each mail is one HTTPS `POST` of JSON to a mail gateway the operator names
 * (`{ from, to, subject, text }`, `Authorization: Bearer <key>`). Which provider sits behind the gateway is the
 * operator's setting, never this repo's; its key is a secret held in the host's environment.
 *
 * The mail says what the LOCAL-TEST line says (`mailFields`), with each link made whole from the app's address. A
 * failed handoff throws, naming only the status: the code, the link and the key never reach a log or an error.
 */

export const GATEWAY_MAIL_TRANSPORT = 'http-gateway';

export class MailTransportRefused extends Error {
  readonly code = 'auth.mail_transport_refused';
  constructor(
    /** The setting to fix, by its environment name. */
    readonly setting: string,
    detail: string,
  ) {
    super(`auth.mail_transport_refused: ${setting} ${detail}`);
    this.name = 'MailTransportRefused';
  }
}

export interface GatewayMailSettings {
  readonly url: string | undefined;
  readonly key: string | undefined;
  readonly from: string | undefined;
  /** The customer app's address; a mail's link is a path under it. */
  readonly linkBase: string | undefined;
  /** The founder console's address, for the staff invite's link only. Unset: a staff invite refuses to send. */
  readonly consoleLinkBase: string | undefined;
}

/** Only dev and test may name a plain-http or loopback address (a fake gateway in a test). */
function addressOf(setting: string, value: string | undefined, local: boolean): URL {
  const raw = value?.trim() ?? '';
  if (raw === '') throw new MailTransportRefused(setting, 'must be set when IDENTITY_MAIL_TRANSPORT is http-gateway');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MailTransportRefused(setting, 'must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new MailTransportRefused(setting, 'must be an https URL');
  }
  if (url.username || url.password) throw new MailTransportRefused(setting, 'must not carry a user or password');
  return url;
}

const SUBJECTS: Readonly<Record<string, string>> = {
  'password-reset': 'Reset your INTAFACED password',
  'password-changed': 'Your INTAFACED password was changed',
  'email-confirm': 'Confirm your email for INTAFACED',
  'email-change': 'Confirm your new INTAFACED email',
  'email-change-notice': 'The email on your INTAFACED account changed',
  'signup-code': 'Your INTAFACED sign-up code',
  'signup-existing': 'Someone tried to sign up with your email',
  'login-code': 'Your INTAFACED sign-in code',
  'new-device-code': 'Your INTAFACED new-device code',
  'mfa-reset-code': 'Your INTAFACED second-step reset code',
  'receive-contact-code': 'Your INTAFACED confirmation code',
  'handle-recovery': 'Your INTAFACED username',
  'staff-invite': 'Your INTAFACED console invitation',
  'support-recovery': 'Recover your INTAFACED account',
  'support-chat-email': 'Your INTAFACED support chat',
  'withdraw-address-approval': 'Approve a new INTAFACED withdrawal address',
  'factor-changed': 'A sign-in method on your INTAFACED account changed',
  'appeal-decided': 'Your INTAFACED appeal was decided',
};

const LABELS: Readonly<Record<string, string>> = {
  code: 'Your code',
  link: 'Open',
  freeze: 'This was not me — freeze my account',
  expires: 'Valid until',
  until: 'Completes at',
  handle: 'Your username',
  anti_phishing: 'Your anti-phishing code',
};

type Message = Parameters<PasswordResetMail['send']>[0];

/** The subject and plain text of one mail. Exported for its test; the transport is the only caller. */
export function gatewayMailContent(
  message: Message,
  links: { readonly app: URL; readonly console: URL | undefined },
): { subject: string; text: string } {
  const purpose = message.purpose ?? 'password-reset';
  const subject = SUBJECTS[purpose] ?? 'A message about your INTAFACED account';
  const lines = mailFields(message).map(([name, value]) => {
    if (name === 'link' || name === 'freeze') {
      const base = purpose === 'staff-invite' && name === 'link' ? links.console : links.app;
      if (!base) throw new MailTransportRefused('IDENTITY_MAIL_CONSOLE_LINK_BASE', 'must be set to send a staff invite');
      return `${LABELS[name]}: ${new URL(value, base.href.endsWith('/') ? base : `${base.href}/`).href}`;
    }
    return `${LABELS[name] ?? name.replace(/_/g, ' ')}: ${value.replace(/_/g, ' ')}`;
  });
  return { subject, text: `${lines.join('\n')}\n\nIf you did not ask for this, you can ignore this mail.\n` };
}

export function openGatewayMail(
  settings: GatewayMailSettings,
  appEnv: string | undefined,
  fetchImpl: typeof fetch = fetch,
): PasswordResetMail {
  const local = appEnv === 'dev' || appEnv === 'test';
  const url = addressOf('IDENTITY_MAIL_GATEWAY_URL', settings.url, local);
  const key = settings.key?.trim() ?? '';
  if (key === '') throw new MailTransportRefused('IDENTITY_MAIL_GATEWAY_KEY', 'must be set when IDENTITY_MAIL_TRANSPORT is http-gateway');
  const from = settings.from?.trim() ?? '';
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from)) {
    throw new MailTransportRefused('IDENTITY_MAIL_FROM', 'must be one sending address');
  }
  const links = {
    app: addressOf('IDENTITY_MAIL_LINK_BASE', settings.linkBase, local),
    console: settings.consoleLinkBase?.trim() ? addressOf('IDENTITY_MAIL_CONSOLE_LINK_BASE', settings.consoleLinkBase, local) : undefined,
  };
  return {
    async send(message) {
      const { subject, text } = gatewayMailContent(message, links);
      const to = message.email.replace(/\s+/g, '');
      let status: number;
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ from, to, subject, text }),
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        await res.body?.cancel().catch(() => undefined);
      } catch (err) {
        const why = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
        throw new Error(`auth.mail_gateway_failed: the mail gateway ${why}`);
      }
      if (status < 200 || status >= 300) throw new Error(`auth.mail_gateway_failed: the mail gateway answered ${status}`);
    },
  };
}

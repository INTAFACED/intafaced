/**
 * How a status subscription email leaves (SP-status-04). Two transports, and none is assumed:
 *
 * - `gateway`: the email channel the owner configured (NOTIFY_EMAIL_GATEWAY_URL and _TOKEN), with NOTIFY_PUBLIC_ORIGIN so
 *   the links in the message open the site. Either missing means no sender.
 * - `local-outbox`: a LOCAL-TEST line per message in a file on this machine, for the local stack and test rigs. Selecting
 *   it outside APP_ENV exactly `dev` or `test` refuses at boot, as svc-identity's local outbox does.
 *
 * With no sender a message is not attempted: the delivery row records `vendor.email` and the page says so.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ChannelDeliveryError, ChannelRefusal, type NotificationChannel } from '../channels/channel.js';

export const STATUS_LOCAL_OUTBOX = 'local-outbox';

export type StatusMail = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Business key: `<event>:<subscriber>:email`. A transport that honours it sends once. */
  readonly key: string;
  /** What the mail is for, as the LOCAL TEST outbox labels it. Status mail when absent; `guest-verify` for the guest door. */
  readonly purpose?: 'status' | 'guest-verify';
};

export type MailOutcome =
  { readonly status: 'accepted' } | { readonly status: 'refused'; readonly code: string } | { readonly status: 'failed' };

export interface StatusMailer {
  /** Which transport sends: the owner's gateway, the LOCAL TEST outbox, or none. */
  readonly kind: 'gateway' | 'local-outbox' | null;
  /** `vendor.email` when nothing can send; null when a message would be attempted. */
  readonly notConnected: 'vendor.email' | null;
  /** Prepended to the paths in a message. Empty for the local outbox, whose reader knows the site. */
  readonly origin: string;
  send(mail: StatusMail): Promise<MailOutcome>;
}

export class NoMailer implements StatusMailer {
  readonly kind = null;
  readonly notConnected = 'vendor.email' as const;
  readonly origin = '';
  async send(): Promise<MailOutcome> {
    return { status: 'refused', code: 'vendor.email' };
  }
}

export class LocalOutboxMailer implements StatusMailer {
  readonly kind = 'local-outbox' as const;
  readonly notConnected = null;
  readonly origin = '';
  constructor(private readonly file: string) {}
  async send(mail: StatusMail): Promise<MailOutcome> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const line = {
      purpose: mail.purpose ?? 'status',
      key: mail.key,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      at: new Date().toISOString(),
    };
    await appendFile(this.file, `LOCAL-TEST ${JSON.stringify(line)}\n`, { mode: 0o600 });
    return { status: 'accepted' };
  }
}

export class GatewayMailer implements StatusMailer {
  readonly kind = 'gateway' as const;
  readonly notConnected = null;
  constructor(
    private readonly channel: NotificationChannel,
    readonly origin: string,
  ) {}
  async send(mail: StatusMail): Promise<MailOutcome> {
    try {
      await this.channel.deliver({
        notificationId: mail.key,
        userId: 'status-subscriber',
        channel: 'email',
        kind: 'status.subscription',
        severity: 'info',
        titleKey: 'status.subscription.title',
        bodyKey: 'status.subscription.body',
        title: mail.subject,
        body: mail.text,
        href: null,
        locale: 'en',
        address: mail.to,
        idempotencyKey: mail.key,
      });
      return { status: 'accepted' };
    } catch (err) {
      if (err instanceof ChannelRefusal) return { status: 'refused', code: err.code };
      if (err instanceof ChannelDeliveryError) return { status: 'failed' };
      throw err;
    }
  }
}

/** Picks the transport at boot. Throws for a local outbox outside dev or test, or with no absolute path. */
export function openStatusMailer(input: {
  appEnv: string | undefined;
  transport: string | undefined;
  outboxPath: string | undefined;
  email: NotificationChannel | undefined;
  publicOrigin: string | undefined;
}): StatusMailer {
  const transport = input.transport?.trim() ?? '';
  if (transport !== '') {
    if (transport !== STATUS_LOCAL_OUTBOX) throw new Error('notify.status_mail_transport_refused: unknown transport');
    if (input.appEnv !== 'dev' && input.appEnv !== 'test')
      throw new Error('notify.status_mail_transport_refused: local-outbox is allowed only when APP_ENV is exactly dev or test');
    const file = input.outboxPath?.trim() ?? '';
    if (!file || !path.isAbsolute(file))
      throw new Error('notify.status_mail_transport_refused: NOTIFY_STATUS_MAIL_OUTBOX must be absolute');
    return new LocalOutboxMailer(file);
  }
  const origin = input.publicOrigin?.trim() ?? '';
  if (!input.email || input.email.unavailableReason !== null || origin === '') return new NoMailer();
  return new GatewayMailer(input.email, origin.replace(/\/$/, ''));
}

/**
 * LOCAL TEST email transport for the notify email channel.
 *
 * Writes one LOCAL-TEST line per delivered email to a file on this machine, in the shape svc-identity's local outbox
 * uses (`LOCAL-TEST purpose=<p> email=<e> ...`), so the local stack and its journeys read notify's mail where they read
 * identity's. Selecting it outside APP_ENV exactly `dev` or `test`, beside an owner-configured email gateway, or with no
 * absolute path refuses at boot. Unset, nothing changes: the email channel stays not connected and refuses honestly.
 *
 * The line carries the kind and the notification id, never the rendered title or body.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ChannelRefusal, type DeliveryReceipt, type NotificationChannel, type OutboundMessage } from './channel.js';

export const LOCAL_OUTBOX_EMAIL_TRANSPORT = 'local-outbox';
export const EMAIL_TRANSPORT_REFUSED = 'notify.email_transport_refused';

/** What the line says the mail is for: `promotion` for a promotion, `notify-<kind>` for anything else. */
export function localOutboxEmailPurpose(kind: string): string {
  if (kind.split('.')[0] === 'promo') return 'promotion';
  return `notify-${kind.replace(/[^A-Za-z0-9]+/g, '-')}`;
}

/** One LOCAL-TEST line. Fields are whitespace-free so a reader can match ` email=<address> `. */
export function localOutboxEmailLine(message: OutboundMessage, at: Date): string {
  const email = message.address.replace(/\s+/g, '');
  const kind = message.kind.replace(/[^A-Za-z0-9._-]+/g, '-');
  const id = message.notificationId.replace(/[^A-Za-z0-9._:-]+/g, '-');
  return `LOCAL-TEST purpose=${localOutboxEmailPurpose(message.kind)} email=${email} kind=${kind} notification=${id} at=${at.toISOString()}\n`;
}

export class LocalOutboxEmailChannel implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason = null;

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    const address = message.address.trim();
    if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(address) || address.length > 320) {
      throw new ChannelRefusal('email', 'channel.target_unroutable');
    }
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, localOutboxEmailLine({ ...message, address }, this.now()), { mode: 0o600 });
    return { reference: null };
  }
}

/**
 * The LOCAL TEST email transport, or null when none is selected. Throws for an unknown transport, an APP_ENV other
 * than exactly dev or test (the raw value: an unset APP_ENV is not dev), a gateway also configured, or a path that is
 * not absolute.
 */
export function openLocalOutboxEmail(input: {
  appEnv: string | undefined;
  transport: string | undefined;
  outboxPath: string | undefined;
  gatewayConfigured: boolean;
}): LocalOutboxEmailChannel | null {
  const transport = input.transport?.trim() ?? '';
  if (transport === '') return null;
  if (transport !== LOCAL_OUTBOX_EMAIL_TRANSPORT) throw new Error(`${EMAIL_TRANSPORT_REFUSED}: unknown transport`);
  if (input.appEnv !== 'dev' && input.appEnv !== 'test')
    throw new Error(`${EMAIL_TRANSPORT_REFUSED}: local-outbox is allowed only when APP_ENV is exactly dev or test`);
  if (input.gatewayConfigured) throw new Error(`${EMAIL_TRANSPORT_REFUSED}: local-outbox cannot stand beside a configured email gateway`);
  const file = input.outboxPath?.trim() ?? '';
  if (!file || !path.isAbsolute(file)) throw new Error(`${EMAIL_TRANSPORT_REFUSED}: NOTIFY_EMAIL_OUTBOX must be an absolute file path`);
  return new LocalOutboxEmailChannel(file);
}

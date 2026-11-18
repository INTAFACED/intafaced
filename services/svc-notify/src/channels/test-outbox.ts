import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { DeliveryReceipt, NotificationChannel, OutboundMessage, RefusalCode } from './channel.js';

/**
 * The TEST email stand-in (J-charts-desk-10 #5). With no email gateway set and `NOTIFY_EMAIL_TEST_OUTBOX` naming an absolute file,
 * the email channel writes each message as one `LOCAL-TEST {json}` line to that file instead of handing it to a transport. Every
 * message is labelled TEST in its subject and text, and the file is the inbox a journey reads. It is refused at boot unless
 * APP_ENV is exactly dev or test, so it can never stand in for a live gateway.
 *
 * The delivery claim on (notification, channel) is what stops a second write of the same message, exactly as it stops a second
 * gateway send; `idempotencyKey` rides on the line so a reader can see it.
 */
export class TestOutboxEmailChannel implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason: RefusalCode | null = null;

  constructor(private readonly file: string) {}

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    const line = {
      purpose: 'notification',
      kind: message.kind,
      notificationId: message.notificationId,
      idempotencyKey: message.idempotencyKey,
      to: message.address,
      subject: `TEST · ${message.title}`,
      text: `TEST — written by the LOCAL TEST email stand-in, not sent.\n\n${message.body}${message.href ? `\n\n${message.href}` : ''}`,
      at: new Date().toISOString(),
    };
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `LOCAL-TEST ${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { reference: `local-test:${message.idempotencyKey}` };
  }
}

/** The stand-in's file, checked: allowed only on a dev or test stack, and only as an absolute path. Blank is no stand-in. */
export function testEmailOutbox(raw: string | undefined, appEnv: string | undefined): string | null {
  const file = raw?.trim() ?? '';
  if (file === '') return null;
  if (appEnv !== 'dev' && appEnv !== 'test')
    throw new Error('NOTIFY_EMAIL_TEST_OUTBOX is allowed only when APP_ENV is exactly dev or test');
  if (!path.isAbsolute(file)) throw new Error('NOTIFY_EMAIL_TEST_OUTBOX must be an absolute path');
  return file;
}

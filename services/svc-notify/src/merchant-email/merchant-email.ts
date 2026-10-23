import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { createTranslator } from '@intafaced/i18n';
import type { DeliveryReceipt, NotificationChannel, OutboundMessage, RefusalCode } from '../channels/channel.js';
import type { CreateResult, NotifyService } from '../notify-service.js';
import type { NotifySeverity } from '../preferences/mute.js';

/**
 * Merchant email for events svc-pay already records. svc-pay publishes no bus
 * subjects (services/svc-pay/README.md). These names are the ones in the code
 * that records the fact:
 *
 *   payment.refunded — PayService.notifyPaymentEvent / MerchantWebhookEventType
 *   rail_refused     — pay.payout_outcomes.kind (payout failure terminal)
 *   dispute_due      — merchant notification kind for a response deadline
 *   invited          — pay.merchant_team_events.action
 *
 * Delivery is NotifyService.create plus the existing dispatcher. The mailbox
 * is the user's confirmed email target. A payload that carries `email` is
 * refused. Kill switches, MuteStore, and the per-channel claim live in the
 * dispatcher. A closed invite, or one past expiresAt, is refused before create.
 *
 * A blank email gateway is the registry's UnconfiguredChannel. The inbox row
 * keeps the real notice. params.code is notify.email_provider_unset, and the
 * read path adds that sentence under the notice. Nothing is handed to a transport.
 *
 * The TEST file channel is off unless NOTIFY_MERCHANT_EMAIL_TEST is exactly
 * "1", a directory is set, and the email gateway URL and token are both blank.
 */

export const MERCHANT_PAY_EVENT_NAMES = ['payment.refunded', 'rail_refused', 'dispute_due', 'invited'] as const;
export type MerchantPayEventName = (typeof MERCHANT_PAY_EVENT_NAMES)[number];

export const EMAIL_PROVIDER_UNSET = 'notify.email_provider_unset' as const;

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const recipientSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const amountSchema = z.string().regex(/^\d+(\.\d{1,18})?$/);
const assetSchema = z.string().regex(/^[A-Z0-9]{2,16}$/);
const instantSchema = z.string().datetime({ offset: true });

const paymentRefunded = z
  .object({
    name: z.literal('payment.refunded'),
    eventId: idSchema,
    recipientUserId: recipientSchema,
    paymentId: idSchema,
    amount: amountSchema,
    assetId: assetSchema,
    outcome: z.enum(['refunded', 'reversed']),
  })
  .strict();

const railRefused = z
  .object({
    name: z.literal('rail_refused'),
    eventId: idSchema,
    recipientUserId: recipientSchema,
    settlementId: idSchema,
    failureCode: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/),
  })
  .strict();

const disputeDue = z
  .object({
    name: z.literal('dispute_due'),
    eventId: idSchema,
    recipientUserId: recipientSchema,
    disputeId: idSchema,
    responseDueAt: instantSchema,
  })
  .strict();

const invited = z
  .object({
    name: z.literal('invited'),
    eventId: idSchema,
    recipientUserId: recipientSchema,
    role: z.enum(['admin', 'finance', 'developer', 'viewer']),
    expiresAt: instantSchema.nullable(),
    inviteOpen: z.boolean(),
  })
  .strict();

export const merchantPayEventSchema = z.discriminatedUnion('name', [paymentRefunded, railRefused, disputeDue, invited]);
export type MerchantPayEvent = z.infer<typeof merchantPayEventSchema>;

const SOURCE_SUBJECT = 'pay.merchant.email';

const COPY: Record<MerchantPayEventName, { titleKey: string; bodyKey: string; severity: NotifySeverity }> = {
  'payment.refunded': {
    titleKey: 'notify.merchant.payment_refunded.title',
    bodyKey: 'notify.merchant.payment_refunded.body',
    severity: 'critical',
  },
  rail_refused: {
    titleKey: 'notify.merchant.rail_refused.title',
    bodyKey: 'notify.merchant.rail_refused.body',
    severity: 'critical',
  },
  dispute_due: {
    titleKey: 'notify.merchant.dispute_due.title',
    bodyKey: 'notify.merchant.dispute_due.body',
    severity: 'critical',
  },
  invited: {
    titleKey: 'notify.merchant.invited.title',
    bodyKey: 'notify.merchant.invited.body',
    severity: 'action',
  },
};

export interface RenderedMerchantEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly href: string;
}

export function portalPath(event: MerchantPayEvent): string {
  switch (event.name) {
    case 'payment.refunded':
      return `/pay/payments/${encodeURIComponent(event.paymentId)}`;
    case 'rail_refused':
      return `/pay/payouts/${encodeURIComponent(event.settlementId)}`;
    case 'dispute_due':
      return `/pay/disputes/${encodeURIComponent(event.disputeId)}`;
    case 'invited':
      return '/pay/team';
  }
}

function copyParams(event: MerchantPayEvent): Record<string, string> {
  switch (event.name) {
    case 'payment.refunded':
      return { outcome: event.outcome, amount: event.amount, assetId: event.assetId };
    case 'rail_refused':
      return { failureCode: event.failureCode };
    case 'dispute_due':
      return { disputeId: event.disputeId, responseDueAt: event.responseDueAt };
    case 'invited':
      return { role: event.role, expiresAt: event.expiresAt ?? 'when the invite is closed' };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text and HTML from the same catalog strings. The mailbox is not copied in. */
export function renderMerchantEmail(event: MerchantPayEvent): RenderedMerchantEmail {
  const spec = COPY[event.name];
  const t = createTranslator('en', undefined, { mode: 'prod' });
  const params = copyParams(event);
  const subject = t.tUnsafe(spec.titleKey, params);
  const body = t.tUnsafe(spec.bodyKey, params);
  const href = portalPath(event);
  const text = `${subject}\n\n${body}\n\nOpen the portal: ${href}\n`;
  const html = [
    '<!DOCTYPE html>',
    '<html><body>',
    `<p>${escapeHtml(subject)}</p>`,
    `<p>${escapeHtml(body)}</p>`,
    `<p><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></p>`,
    '</body></html>',
  ].join('');
  return { subject, text, html, href };
}

/**
 * TEST email file. `channelsFromEnv` selects it only when the flag is "1",
 * a directory is set, and the email gateway URL and token are both blank.
 */
export class TestMerchantEmlChannel implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason: RefusalCode | null = null;

  constructor(private readonly dir: string) {}

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    const name = createHash('sha256').update(message.idempotencyKey).digest('hex');
    const file = join(this.dir, `${name}.eml`);
    const boundary = `merch_${name.slice(0, 12)}`;
    const text = `${message.title}\n\n${message.body}\n\n${message.href ?? ''}\n`;
    const html = `<p>${escapeHtml(message.title)}</p><p>${escapeHtml(message.body)}</p><p>${escapeHtml(message.href ?? '')}</p>`;
    const eml = [
      `To: ${message.address}`,
      `Subject: ${message.title}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    await mkdir(this.dir, { recursive: true });
    await writeFile(file, eml, { encoding: 'utf8', flag: 'wx' });
    return { reference: file };
  }
}

export type MerchantEmailResult =
  | { readonly status: 'expired' }
  | { readonly status: 'duplicate' }
  | { readonly status: 'preference_off'; readonly notificationId: string }
  | { readonly status: 'recorded'; readonly code: typeof EMAIL_PROVIDER_UNSET; readonly notificationId: string }
  | { readonly status: 'sent'; readonly notificationId: string }
  | { readonly status: 'refused'; readonly code: RefusalCode; readonly notificationId: string | null }
  | {
      readonly status: 'failed';
      readonly code: RefusalCode | null;
      readonly detail: string | null;
      readonly notificationId: string | null;
    };

function idempotencyKey(event: MerchantPayEvent): string {
  return `${event.name}:${event.eventId}:${event.recipientUserId}`;
}

function inviteExpired(event: MerchantPayEvent, now: Date): boolean {
  if (event.name !== 'invited') return false;
  if (!event.inviteOpen) return true;
  if (event.expiresAt === null) return false;
  const at = Date.parse(event.expiresAt);
  return Number.isFinite(at) && at <= now.getTime();
}

function emailUnconfigured(notify: NotifyService): boolean {
  return notify.channelStatus().find((row) => row.channel === 'email')?.reason === 'channel.not_configured';
}

function fromCreate(created: CreateResult): MerchantEmailResult {
  const notificationId = created.notification?.id ?? created.dispatch?.notificationId ?? null;
  const email = created.dispatch?.outcomes.find((row) => row.channel === 'email');

  if (!created.dispatch) {
    return { status: 'refused', code: 'channel.disabled', notificationId };
  }

  if (email?.status === 'accepted') {
    if (!notificationId) {
      return { status: 'failed', code: null, detail: 'accepted email has no notification id', notificationId: null };
    }
    return { status: 'sent', notificationId };
  }

  // A redelivery that did not accept a new send is the original event again.
  // A retryable failure still in flight is not that: the caller may be the
  // recovery pass, or the other side of a race that has not finished.
  if (!created.inserted) {
    const stillTrying = email?.status === 'failed' && email.retryable;
    if (!stillTrying) return { status: 'duplicate' };
  }

  if (email?.code === 'channel.muted' && notificationId) {
    return { status: 'preference_off', notificationId };
  }
  if (email?.code === 'channel.not_configured' && notificationId) {
    return { status: 'recorded', code: EMAIL_PROVIDER_UNSET, notificationId };
  }
  if (email?.status === 'failed') {
    return { status: 'failed', code: email.code, detail: email.detail, notificationId };
  }
  if (email?.status === 'refused' || email?.status === 'abandoned') {
    return { status: 'refused', code: email.code ?? 'channel.transport_rejected', notificationId };
  }
  if (!email) {
    return { status: 'refused', code: 'channel.no_target', notificationId };
  }
  return { status: 'duplicate' };
}

export async function deliverMerchantEmail(
  deps: {
    readonly notify: NotifyService;
    readonly now?: () => Date;
  },
  raw: unknown,
): Promise<MerchantEmailResult> {
  const event = merchantPayEventSchema.parse(raw);
  const spec = COPY[event.name];
  const now = deps.now ?? (() => new Date());
  if (inviteExpired(event, now())) return { status: 'expired' };

  const unset = emailUnconfigured(deps.notify);
  const created = await deps.notify.create({
    userId: event.recipientUserId,
    kind: event.name,
    titleKey: spec.titleKey,
    bodyKey: spec.bodyKey,
    params: unset ? { ...copyParams(event), code: EMAIL_PROVIDER_UNSET } : copyParams(event),
    href: portalPath(event),
    severity: spec.severity,
    sourceSubject: SOURCE_SUBJECT,
    sourceIdempotencyKey: idempotencyKey(event),
  });
  return fromCreate(created);
}

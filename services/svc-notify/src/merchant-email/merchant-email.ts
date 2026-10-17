import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createTranslator } from '@intafaced/i18n';
import { isChannelMuted, type ChannelMutePrefs, type NotifySeverity } from '../preferences/mute.js';
import type { NotifyStore } from '../store.js';

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
 * Money events are severity critical. Channel mute does not silence critical
 * (preferences/mute.ts). A team invite is action, so an email mute skips it.
 * NOTIFY_TOPICS has no `pay`, so topic mute does not apply (same as
 * pay.request_created).
 *
 * No provider is named. A blank provider writes one inbox row whose title is
 * "email not set up yet" and whose params.code is notify.email_provider_unset.
 * Nothing is handed to a transport. The TEST file transport runs only when
 * NOTIFY_MERCHANT_EMAIL_TEST=1 and a directory is set.
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
const emailSchema = z
  .string()
  .trim()
  .max(320)
  .regex(/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/);
const instantSchema = z.string().datetime({ offset: true });

const paymentRefunded = z
  .object({
    name: z.literal('payment.refunded'),
    eventId: idSchema,
    recipientUserId: recipientSchema,
    email: emailSchema,
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
    email: emailSchema,
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
    email: emailSchema,
    disputeId: idSchema,
    responseDueAt: instantSchema,
  })
  .strict();

const invited = z
  .object({
    name: z.literal('invited'),
    eventId: idSchema,
    recipientUserId: recipientSchema,
    email: emailSchema,
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

export interface MerchantEmailProvider {
  send(input: { to: string; subject: string; text: string; html: string; idempotencyKey: string }): Promise<{ reference: string }>;
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

const TEST_FLAG = 'NOTIFY_MERCHANT_EMAIL_TEST';
const TEST_DIR = 'NOTIFY_MERCHANT_EMAIL_TEST_DIR';

/** Blank unless the TEST flag is exactly "1" and a directory is set. Never picks a live provider. */
export function merchantEmailProviderFromEnv(
  env: Record<string, string | undefined>,
  write: (file: string, body: string) => Promise<void> = async (file, body) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, { encoding: 'utf8', flag: 'wx' });
  },
): MerchantEmailProvider | null {
  if (env[TEST_FLAG] !== '1') return null;
  const dir = env[TEST_DIR]?.trim();
  if (!dir) return null;
  return {
    async send(input) {
      const name = createHash('sha256').update(input.idempotencyKey).digest('hex');
      const file = join(dir, `${name}.eml`);
      const boundary = `merch_${name.slice(0, 16)}`;
      const eml = [
        `To: ${input.to}`,
        `Subject: ${input.subject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        input.text,
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        '',
        input.html,
        `--${boundary}--`,
        '',
      ].join('\r\n');
      await write(file, eml);
      return { reference: file };
    },
  };
}

export type MerchantEmailResult =
  | { readonly status: 'preference_off' }
  | { readonly status: 'expired' }
  | { readonly status: 'duplicate' }
  | { readonly status: 'recorded'; readonly code: typeof EMAIL_PROVIDER_UNSET; readonly notificationId: string }
  | { readonly status: 'sent'; readonly notificationId: string; readonly reference: string };

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

export async function deliverMerchantEmail(
  deps: {
    readonly store: NotifyStore;
    readonly provider: MerchantEmailProvider | null;
    readonly now?: () => Date;
    readonly muteFor?: (userId: string) => ChannelMutePrefs;
  },
  raw: unknown,
): Promise<MerchantEmailResult> {
  const event = merchantPayEventSchema.parse(raw);
  const spec = COPY[event.name];
  const now = deps.now ?? (() => new Date());
  const mute = deps.muteFor?.(event.recipientUserId) ?? { muted: new Set() };
  if (isChannelMuted(mute, 'email', spec.severity)) return { status: 'preference_off' };
  if (inviteExpired(event, now())) return { status: 'expired' };

  const key = idempotencyKey(event);
  const existing = await deps.store.findBySource(event.recipientUserId, SOURCE_SUBJECT, key);
  if (existing) return { status: 'duplicate' };

  const rendered = renderMerchantEmail(event);
  const provider = deps.provider;
  const receipt = provider
    ? await provider.send({
        to: event.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        idempotencyKey: key,
      })
    : null;
  const inserted = await deps.store.insert({
    userId: event.recipientUserId,
    kind: event.name,
    titleKey: provider ? spec.titleKey : 'notify.merchant.email_provider_unset.title',
    bodyKey: provider ? spec.bodyKey : 'notify.merchant.email_provider_unset.body',
    params: {
      ...copyParams(event),
      code: provider ? 'sent' : EMAIL_PROVIDER_UNSET,
      event: event.name,
    },
    href: rendered.href,
    severity: spec.severity,
    sourceSubject: SOURCE_SUBJECT,
    sourceIdempotencyKey: key,
  });
  if (!inserted.inserted || !inserted.notification) return { status: 'duplicate' };
  if (!receipt) return { status: 'recorded', code: EMAIL_PROVIDER_UNSET, notificationId: inserted.notification.id };
  return { status: 'sent', notificationId: inserted.notification.id, reference: receipt.reference };
}

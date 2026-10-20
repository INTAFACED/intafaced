import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { InAppChannel, UnconfiguredChannel } from '../channels/gateway.js';
import { EmailChannel } from '../channels/adapters.js';
import { ChannelDeliveryError, type NotificationChannel, type OutboundMessage } from '../channels/channel.js';
import { ChannelRegistry, channelsFromEnv } from '../channels/registry.js';
import { renderInboxCopy } from '../channels/render.js';
import { MemoryDeliveryStore, MemoryTargetStore } from '../channel-store.js';
import { NotificationDispatcher } from '../dispatch.js';
import { NotifyService } from '../notify-service.js';
import { MemoryMuteStore } from '../preferences/mute.js';
import { MemoryNotifyStore } from '../store.js';
import {
  EMAIL_PROVIDER_UNSET,
  MERCHANT_PAY_EVENT_NAMES,
  deliverMerchantEmail,
  renderMerchantEmail,
  type MerchantPayEvent,
} from './merchant-email.js';

const USER = 'merchant-user-1';
const OTHER = 'merchant-user-2';
const CONFIRMED = 'confirmed@example.test';
const CANARY = 'tok_live_secret_4242424242424242';
const TIMEOUT = { NOTIFY_GATEWAY_TIMEOUT_MS: 1_000 } as const;

const refund = (over: Partial<Extract<MerchantPayEvent, { name: 'payment.refunded' }>> = {}): MerchantPayEvent => ({
  name: 'payment.refunded',
  eventId: 'evt-refund-1',
  recipientUserId: USER,
  paymentId: 'pay-1',
  amount: '10.500',
  assetId: 'USDT',
  outcome: 'refunded',
  ...over,
});

const payout = (over: Partial<Extract<MerchantPayEvent, { name: 'rail_refused' }>> = {}): MerchantPayEvent => ({
  name: 'rail_refused',
  eventId: 'evt-payout-1',
  recipientUserId: USER,
  settlementId: 'set-1',
  failureCode: 'rail.declined',
  ...over,
});

const dispute = (over: Partial<Extract<MerchantPayEvent, { name: 'dispute_due' }>> = {}): MerchantPayEvent => ({
  name: 'dispute_due',
  eventId: 'evt-dispute-1',
  recipientUserId: USER,
  disputeId: 'dsp-1',
  responseDueAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...over,
});

const invite = (over: Partial<Extract<MerchantPayEvent, { name: 'invited' }>> = {}): MerchantPayEvent => ({
  name: 'invited',
  eventId: 'evt-invite-1',
  recipientUserId: USER,
  role: 'finance',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  inviteOpen: true,
  ...over,
});

const samples: readonly MerchantPayEvent[] = [refund(), payout(), dispute(), invite()];

/** Records deliver() calls. A retryable failure is thrown before the call is counted as a send. */
class SpyEmail implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason = null;
  readonly sent: OutboundMessage[] = [];
  failuresLeft: number;

  constructor(failures = 0) {
    this.failuresLeft = failures;
  }

  async deliver(message: OutboundMessage) {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new ChannelDeliveryError(this.channel, 'gateway responded 503', { retryable: true, status: 503 });
    }
    this.sent.push(message);
    return { reference: `spy-${this.sent.length}` };
  }
}

function harness(email: NotificationChannel, options: { outOfAppEnabled?: boolean; maxAttempts?: number } = {}) {
  const channels = new ChannelRegistry([
    new InAppChannel(),
    email,
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
  const store = new MemoryNotifyStore();
  const targets = new MemoryTargetStore();
  const deliveries = new MemoryDeliveryStore();
  const muteStore = new MemoryMuteStore();
  const dispatcher = new NotificationDispatcher(channels, targets, deliveries, {
    maxAttempts: options.maxAttempts ?? 3,
    outOfAppEnabled: options.outOfAppEnabled ?? true,
    mutePrefsOf: (userId) => muteStore.get(userId),
  });
  const notify = new NotifyService(store, { fanoutEnabled: true }, { targets, deliveries, channels, dispatcher, muteStore });
  return { notify, store, targets, deliveries, muteStore, channels };
}

async function confirm(targets: MemoryTargetStore, userId: string, address = CONFIRMED): Promise<void> {
  await targets.upsert({
    userId,
    channel: 'email',
    address,
    locale: 'en',
    verifyTokenHash: 'x'.repeat(64),
    verifyExpiresAt: new Date(Date.now() + 60_000),
  });
  await targets.markVerified(userId, 'email', 'x'.repeat(64), new Date());
}

async function registerUnconfirmed(targets: MemoryTargetStore, userId: string): Promise<void> {
  await targets.upsert({
    userId,
    channel: 'email',
    address: CONFIRMED,
    locale: 'en',
    verifyTokenHash: 'y'.repeat(64),
    verifyExpiresAt: new Date(Date.now() + 60_000),
  });
}

async function inbox(notify: NotifyService, userId = USER) {
  return notify.list({ userId, cursor: null, limit: 20, unreadOnly: false });
}

describe('merchant email templates', () => {
  it('names the pay events this channel consumes', () => {
    expect([...MERCHANT_PAY_EVENT_NAMES]).toEqual(['payment.refunded', 'rail_refused', 'dispute_due', 'invited']);
  });

  it('renders plain text and HTML for each event without secrets or credential links', () => {
    for (const event of samples) {
      const rendered = renderMerchantEmail(event);
      expect(rendered.text.length).toBeGreaterThan(0);
      expect(rendered.html).toContain('<!DOCTYPE html>');
      expect(rendered.html).toContain(`<a href="${rendered.href}">`);
      expect(rendered.text).toContain(rendered.href);
      expect(rendered.href.startsWith('/pay/')).toBe(true);
      expect(rendered.href).not.toContain('?');
      expect(rendered.href).not.toContain(CONFIRMED);
      expect(rendered.text).not.toContain(CONFIRMED);
      expect(rendered.html).not.toContain(CONFIRMED);
      expect(rendered.text).not.toContain(CANARY);
      expect(rendered.html).not.toContain(CANARY);
      expect(rendered.text).not.toMatch(/\b\d{13,19}\b/);
    }
    expect(renderMerchantEmail(refund()).text).toContain('10.500');
    expect(renderMerchantEmail(refund()).text).not.toContain('10.5 ');
  });

  it('refuses a payload that carries a secret field', async () => {
    const spy = new SpyEmail();
    const h = harness(spy);
    await expect(deliverMerchantEmail({ notify: h.notify }, { ...refund(), cardNumber: CANARY, token: CANARY })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(spy.sent).toEqual([]);
    expect((await inbox(h.notify)).items).toEqual([]);
  });
});

describe('merchant email through the notify pipeline', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('refuses a payload that includes email, writes nothing, and sends nothing', async () => {
    const spy = new SpyEmail();
    const h = harness(spy);
    await confirm(h.targets, USER);
    await expect(deliverMerchantEmail({ notify: h.notify }, { ...refund(), email: CONFIRMED })).rejects.toBeInstanceOf(ZodError);
    expect(spy.sent).toEqual([]);
    expect((await inbox(h.notify)).items).toEqual([]);
  });

  it('records channel.no_target when no email is confirmed, and channel.target_unverified when the address was never confirmed', async () => {
    const missing = new SpyEmail();
    const noTarget = harness(missing);
    const none = await deliverMerchantEmail({ notify: noTarget.notify }, refund());
    expect(none).toMatchObject({ status: 'refused', code: 'channel.no_target' });
    expect(missing.sent).toEqual([]);

    const unverified = new SpyEmail();
    const pending = harness(unverified);
    await registerUnconfirmed(pending.targets, USER);
    const held = await deliverMerchantEmail({ notify: pending.notify }, refund({ eventId: 'evt-refund-unverified' }));
    expect(held).toMatchObject({ status: 'refused', code: 'channel.target_unverified' });
    expect(unverified.sent).toEqual([]);
    const emailRow = (await pending.deliveries.listForNotification((held as { notificationId: string }).notificationId)).find(
      (row) => row.channel === 'email',
    );
    expect(emailRow).toMatchObject({ status: 'refused', refusalCode: 'channel.target_unverified' });
  });

  it('sends nothing when out-of-app delivery is off, for a critical event and an action event', async () => {
    const spy = new SpyEmail();
    const h = harness(spy, { outOfAppEnabled: false });
    await confirm(h.targets, USER);
    const money = await deliverMerchantEmail({ notify: h.notify }, refund());
    const team = await deliverMerchantEmail({ notify: h.notify }, invite());
    expect(money).toMatchObject({ status: 'refused', code: 'channel.disabled' });
    expect(team).toMatchObject({ status: 'refused', code: 'channel.disabled' });
    expect(spy.sent).toEqual([]);
  });

  it('does not send a muted invite, and still sends a muted refund to the confirmed target', async () => {
    const spy = new SpyEmail();
    const h = harness(spy);
    await confirm(h.targets, USER);
    await h.muteStore.setMuted(USER, 'email', true);
    const skipped = await deliverMerchantEmail({ notify: h.notify }, invite());
    expect(skipped).toMatchObject({ status: 'preference_off' });
    expect(spy.sent).toEqual([]);
    const money = await deliverMerchantEmail({ notify: h.notify }, refund({ eventId: 'evt-refund-muted' }));
    expect(money).toMatchObject({ status: 'sent' });
    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0]?.address).toBe(CONFIRMED);
    expect(spy.sent[0]?.href).toBe('/pay/payments/pay-1');
  });

  it('records notify.email_provider_unset when the email gateway is blank and does not call the transport', async () => {
    const spyTransport = vi.fn();
    const channels = channelsFromEnv(TIMEOUT, spyTransport as typeof fetch);
    const h = harness(channels.get('email')!);
    await confirm(h.targets, USER);
    const result = await deliverMerchantEmail({ notify: h.notify }, refund());
    expect(result).toMatchObject({ status: 'recorded', code: EMAIL_PROVIDER_UNSET });
    expect(spyTransport).not.toHaveBeenCalled();
    const page = await inbox(h.notify);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.titleKey).toBe('notify.merchant.payment_refunded.title');
    expect(page.items[0]?.params.code).toBe(EMAIL_PROVIDER_UNSET);
    const copy = renderInboxCopy(page.items[0]!, 'en');
    expect(copy.title).toBe('Refund outcome');
    expect(copy.body).toContain('Refund refunded for 10.500 USDT.');
    expect(copy.body).toContain('This notice stayed in the portal. Email is not set up yet.');
  });

  it('leaves email unconfigured unless the test flag and directory are both set on a blank gateway', () => {
    expect(channelsFromEnv({ ...TIMEOUT, NOTIFY_MERCHANT_EMAIL_TEST: '1' }).get('email')).toBeInstanceOf(UnconfiguredChannel);
    expect(channelsFromEnv({ ...TIMEOUT, NOTIFY_MERCHANT_EMAIL_TEST_DIR: '/tmp/merch-mail-off' }).get('email')).toBeInstanceOf(
      UnconfiguredChannel,
    );
    const wired = channelsFromEnv({
      ...TIMEOUT,
      NOTIFY_EMAIL_GATEWAY_URL: 'https://gateway.internal/email',
      NOTIFY_EMAIL_GATEWAY_TOKEN: 't'.repeat(16),
      NOTIFY_MERCHANT_EMAIL_TEST: '1',
      NOTIFY_MERCHANT_EMAIL_TEST_DIR: '/tmp/merch-mail-on',
    }).get('email');
    expect(wired).toBeInstanceOf(EmailChannel);
    const testOnly = channelsFromEnv({
      ...TIMEOUT,
      NOTIFY_MERCHANT_EMAIL_TEST: '1',
      NOTIFY_MERCHANT_EMAIL_TEST_DIR: '/tmp/merch-mail-on',
    }).get('email');
    expect(testOnly).not.toBeInstanceOf(UnconfiguredChannel);
    expect(testOnly?.unavailableReason).toBeNull();
  });

  it('writes one eml when the test flag and directory are set and the gateway is blank', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merchmail-'));
    dirs.push(dir);
    const channels = channelsFromEnv({
      ...TIMEOUT,
      NOTIFY_MERCHANT_EMAIL_TEST: '1',
      NOTIFY_MERCHANT_EMAIL_TEST_DIR: dir,
    });
    const h = harness(channels.get('email')!);
    await confirm(h.targets, USER);
    const first = await deliverMerchantEmail({ notify: h.notify }, payout());
    const second = await deliverMerchantEmail({ notify: h.notify }, payout());
    expect(first).toMatchObject({ status: 'sent' });
    expect(second).toEqual({ status: 'duplicate' });
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const eml = await readFile(join(dir, files[0]!), 'utf8');
    expect(eml).toContain('text/plain');
    expect(eml).toContain('text/html');
    expect(eml).toContain('/pay/payouts/set-1');
    expect(eml).toContain(CONFIRMED);
    expect(eml).not.toContain(CANARY);
    const page = await inbox(h.notify);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.titleKey).toBe('notify.merchant.rail_refused.title');
    expect(renderInboxCopy(page.items[0]!, 'en').title).toBe('Payout failed');
  });

  it('keeps one inbox row when the same event is delivered twice, and a second recipient is a different row', async () => {
    const channels = channelsFromEnv(TIMEOUT);
    const h = harness(channels.get('email')!);
    await confirm(h.targets, USER);
    await confirm(h.targets, OTHER, 'other@example.test');
    const first = await deliverMerchantEmail({ notify: h.notify }, dispute());
    const second = await deliverMerchantEmail({ notify: h.notify }, dispute());
    expect(first).toMatchObject({ status: 'recorded', code: EMAIL_PROVIDER_UNSET });
    expect(second).toEqual({ status: 'duplicate' });
    expect((await inbox(h.notify)).items).toHaveLength(1);
    const other = await deliverMerchantEmail({ notify: h.notify }, dispute({ recipientUserId: OTHER }));
    expect(other).toMatchObject({ status: 'recorded', code: EMAIL_PROVIDER_UNSET });
    expect((await inbox(h.notify, OTHER)).items).toHaveLength(1);
  });

  it('does not email a team invite that is closed or already past expiresAt', async () => {
    const spy = new SpyEmail();
    const h = harness(spy);
    await confirm(h.targets, USER);
    const closed = await deliverMerchantEmail(
      { notify: h.notify, now: () => new Date('2026-10-18T00:00:00.000Z') },
      invite({ inviteOpen: false }),
    );
    const past = await deliverMerchantEmail(
      { notify: h.notify, now: () => new Date('2026-10-21T00:00:00.000Z') },
      invite({ eventId: 'evt-invite-past', expiresAt: '2026-10-20T00:00:00.000Z' }),
    );
    expect(closed).toEqual({ status: 'expired' });
    expect(past).toEqual({ status: 'expired' });
    expect(spy.sent).toEqual([]);
    expect((await inbox(h.notify)).items).toEqual([]);
  });

  it('sends one email and writes one inbox row when the same event is delivered concurrently', async () => {
    const spy = new SpyEmail();
    const h = harness(spy);
    await confirm(h.targets, USER);
    const event = refund({ eventId: 'evt-refund-race' });
    await Promise.all([deliverMerchantEmail({ notify: h.notify }, event), deliverMerchantEmail({ notify: h.notify }, event)]);
    expect(spy.sent).toHaveLength(1);
    expect((await inbox(h.notify)).items).toHaveLength(1);
  });

  it('sends once in total when the first send throws a retryable error after the inbox insert', async () => {
    const spy = new SpyEmail(1);
    const h = harness(spy);
    await confirm(h.targets, USER);
    const event = refund({ eventId: 'evt-refund-crash' });
    const first = await deliverMerchantEmail({ notify: h.notify }, event);
    expect(first.status).not.toBe('sent');
    expect(first).toMatchObject({ status: 'failed' });
    expect(spy.sent).toEqual([]);
    expect((await inbox(h.notify)).items).toHaveLength(1);
    const second = await deliverMerchantEmail({ notify: h.notify }, event);
    expect(second).toMatchObject({ status: 'sent' });
    expect(spy.sent).toHaveLength(1);
    expect((await inbox(h.notify)).items).toHaveLength(1);
  });
});

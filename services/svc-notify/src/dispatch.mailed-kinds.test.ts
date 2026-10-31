import { describe, expect, it } from 'vitest';
import type { NotificationChannel, OutboundMessage } from './channels/channel.js';
import { InAppChannel, UnconfiguredChannel } from './channels/gateway.js';
import { ChannelRegistry } from './channels/registry.js';
import { MemoryDeliveryStore, MemoryTargetStore, shouldReapDelivery } from './channel-store.js';
import { MAILED_KINDS, NotificationDispatcher, type DispatchOptions } from './dispatch.js';
import type { Notification } from './store.js';

/**
 * SP-csat-01 (J-support-public-04 #8): the rating ask's mailed copy is owed. With no email sender set, its email row
 * waits `pending` named `vendor.email`: never attempted, never accepted, never reaped, and written once however often
 * the event is redelivered. Other kinds keep the old rule: nothing is written on a channel nobody can use.
 */

const USER = 'user-1';

class SentEmail implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason = null;
  readonly sent: OutboundMessage[] = [];
  async deliver(req: OutboundMessage) {
    this.sent.push(req);
    return { reference: 'ref-1' };
  }
}

function registry(
  email: NotificationChannel = new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
) {
  return new ChannelRegistry([
    new InAppChannel(),
    email,
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
}

function rateAsk(overrides: Partial<Notification> = {}): Notification {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: USER,
    kind: 'support.rate_request',
    severity: 'info',
    titleKey: 'notify.support.rate_request.title',
    bodyKey: 'notify.support.rate_request.body',
    params: {},
    href: null,
    readAt: null,
    sourceSubject: 'intafaced.support.ticket.resolved',
    sourceIdempotencyKey: 'ticket-1',
    createdAt: new Date(),
    ...overrides,
  } as Notification;
}

function dispatcher(
  deliveries: MemoryDeliveryStore,
  options: Partial<DispatchOptions> = {},
  reg = registry(),
  targets = new MemoryTargetStore(),
): NotificationDispatcher {
  return new NotificationDispatcher(reg, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: true, ...options });
}

describe('a mailed ask with no email sender waits vendor.email', () => {
  it('names the rating ask', () => {
    expect(MAILED_KINDS.has('support.rate_request')).toBe(true);
  });

  it('writes one waiting email row next to the inbox row, and asks for no redelivery', async () => {
    const deliveries = new MemoryDeliveryStore();
    const report = await dispatcher(deliveries).dispatch(rateAsk());

    expect(report.outcomes.find((o) => o.channel === 'email')).toEqual({
      channel: 'email',
      status: 'waiting',
      code: 'vendor.email',
      detail: 'no confirmed address on this channel',
      retryable: false,
    });
    expect(report.retry).toBe(false);
    const email = (await deliveries.listForNotification(rateAsk().id)).find((row) => row.channel === 'email');
    expect(email).toMatchObject({
      status: 'pending',
      attempts: 0,
      refusalCode: 'vendor.email',
      attemptedAt: null,
      acceptedAt: null,
      leaseUntil: null,
    });
  });

  it('a redelivered event writes nothing new', async () => {
    const deliveries = new MemoryDeliveryStore();
    await dispatcher(deliveries).dispatch(rateAsk());
    const first = (await deliveries.listForNotification(rateAsk().id)).find((row) => row.channel === 'email');
    await dispatcher(deliveries).dispatch(rateAsk());
    const rows = (await deliveries.listForNotification(rateAsk().id)).filter((row) => row.channel === 'email');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first!.id, status: 'pending', attempts: 0 });
  });

  it('the waiting row is never reaped as stuck or exhausted', async () => {
    const deliveries = new MemoryDeliveryStore();
    await dispatcher(deliveries).dispatch(rateAsk());
    const email = (await deliveries.listForNotification(rateAsk().id)).find((row) => row.channel === 'email')!;
    const muchLater = new Date(Date.now() + 30 * 86_400_000);
    expect(shouldReapDelivery(email, 1, muchLater, 1_000)).toBe(false);
  });

  it('a person who muted email is refused channel.muted, not owed a mail', async () => {
    const deliveries = new MemoryDeliveryStore();
    const report = await dispatcher(deliveries, { mutePrefsOf: () => ({ muted: new Set(['email']) }) }).dispatch(rateAsk());
    expect(report.outcomes.find((o) => o.channel === 'email')).toMatchObject({ status: 'refused', code: 'channel.muted' });
  });

  it('with out-of-app sending switched off, nothing waits', async () => {
    const deliveries = new MemoryDeliveryStore();
    const report = await dispatcher(deliveries, { outOfAppEnabled: false }).dispatch(rateAsk());
    expect(report.outcomes.map((o) => o.channel)).toEqual(['inapp']);
  });

  it('another kind keeps the old rule: no address, no email row', async () => {
    const deliveries = new MemoryDeliveryStore();
    const report = await dispatcher(deliveries).dispatch(rateAsk({ kind: 'support.ticket_reply' }));
    expect(report.outcomes.map((o) => o.channel)).toEqual(['inapp']);
  });

  it('with a sender set, the ask is sent to a confirmed address and nothing waits', async () => {
    const deliveries = new MemoryDeliveryStore();
    const email = new SentEmail();
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'person@example.test',
      locale: 'en',
      verifyTokenHash: 'code-hash',
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(await targets.markVerified(USER, 'email', 'code-hash', new Date())).toBe(true);
    const report = await dispatcher(deliveries, {}, registry(email), targets).dispatch(rateAsk());
    expect(report.outcomes.find((o) => o.channel === 'email')).toMatchObject({ status: 'accepted' });
    expect(email.sent).toHaveLength(1);
  });

  it('a confirmed address with no sender set waits too, after the address gates, with no second reason', async () => {
    const deliveries = new MemoryDeliveryStore();
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'person@example.test',
      locale: 'en',
      verifyTokenHash: 'code-hash',
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(await targets.markVerified(USER, 'email', 'code-hash', new Date())).toBe(true);
    const report = await dispatcher(deliveries, {}, registry(), targets).dispatch(rateAsk());
    expect(report.outcomes.find((o) => o.channel === 'email')).toMatchObject({ status: 'waiting', code: 'vendor.email', detail: null });
  });

  it('an address never confirmed is named in the detail', async () => {
    const deliveries = new MemoryDeliveryStore();
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'person@example.test',
      locale: 'en',
      verifyTokenHash: 'code-hash',
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    const report = await dispatcher(deliveries, {}, registry(), targets).dispatch(rateAsk());
    expect(report.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'waiting',
      detail: 'address registered but never confirmed',
    });
  });

  it('a claim already on the row is reported in flight and asks for a redelivery, never as failed for good', async () => {
    const deliveries = new MemoryDeliveryStore({ leaseMs: 60_000 });
    expect((await deliveries.claim(rateAsk().id, 'email', 3)).claimed).toBe(true);
    const report = await dispatcher(deliveries).dispatch(rateAsk());
    expect(report.outcomes.find((o) => o.channel === 'email')).toMatchObject({ status: 'failed', retryable: true });
    expect(report.retry).toBe(true);
  });

  it('a later claim of the waiting row no longer reads vendor.email', async () => {
    const deliveries = new MemoryDeliveryStore();
    await dispatcher(deliveries).dispatch(rateAsk());
    const claim = await deliveries.claim(rateAsk().id, 'email', 3);
    expect(claim).toMatchObject({ claimed: true, attempt: 1 });
    const email = (await deliveries.listForNotification(rateAsk().id)).find((row) => row.channel === 'email');
    expect(email).toMatchObject({ status: 'pending', attempts: 1, refusalCode: null });
  });
});

import { describe, expect, it } from 'vitest';
import type { NotificationChannel, OutboundMessage } from './channels/channel.js';
import { InAppChannel, UnconfiguredChannel } from './channels/gateway.js';
import { ChannelRegistry } from './channels/registry.js';
import { MemoryDeliveryStore, MemoryTargetStore } from './channel-store.js';
import { NotificationDispatcher, type DispatchOptions } from './dispatch.js';
import { CategoryPrefs, MemoryCategoryPrefStore } from './preferences/categories.js';
import type { CommandLog } from './preferences/account.js';
import type { Notification } from './store.js';

/**
 * J-identity-10 #3: a person who confirmed no email address in notify is mailed at the email they proved in identity,
 * while the email channel can send. The read fails closed, and the category choice still decides.
 */

const USER = '22222222-2222-4222-8222-222222222222';

class SentEmail implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason = null;
  readonly sent: OutboundMessage[] = [];
  async deliver(req: OutboundMessage) {
    this.sent.push(req);
    return { reference: null };
  }
}

function registry(email: NotificationChannel) {
  return new ChannelRegistry([
    new InAppChannel(),
    email,
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
}

function promo(overrides: Partial<Notification> = {}): Notification {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    userId: USER,
    kind: 'promo.test',
    severity: 'info',
    titleKey: 'notify.promo.test.title',
    bodyKey: 'notify.promo.test.body',
    params: {},
    href: null,
    readAt: null,
    sourceSubject: 'local-test.notify.promotion',
    sourceIdempotencyKey: 'promo-1',
    createdAt: new Date(),
    ...overrides,
  } as Notification;
}

function dispatcher(email: NotificationChannel, options: Partial<DispatchOptions>, targets = new MemoryTargetStore()) {
  return new NotificationDispatcher(registry(email), targets, new MemoryDeliveryStore(), {
    maxAttempts: 3,
    outOfAppEnabled: true,
    ...options,
  });
}

describe('the email channel falls back to the proved account email', () => {
  it('mails the proved account email when the person confirmed none in notify', async () => {
    const email = new SentEmail();
    const asked: string[] = [];
    const report = await dispatcher(email, {
      provedAccountEmail: async (userId) => {
        asked.push(userId);
        return 'pfn@local-test.invalid';
      },
    }).dispatch(promo());
    expect(asked).toEqual([USER]);
    expect(email.sent.map((m) => m.address)).toEqual(['pfn@local-test.invalid']);
    expect(report.outcomes.find((o) => o.channel === 'email')).toMatchObject({ status: 'accepted' });
  });

  it('uses the person’s own confirmed address first and never asks identity', async () => {
    const email = new SentEmail();
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'own@local-test.invalid',
      locale: 'en',
      verifyTokenHash: 'h',
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    await targets.markVerified(USER, 'email', 'h', new Date());
    let asked = 0;
    const read = async () => {
      asked += 1;
      return 'other@local-test.invalid';
    };
    await dispatcher(email, { provedAccountEmail: read }, targets).dispatch(promo());
    expect(asked).toBe(0);
    expect(email.sent.map((m) => m.address)).toEqual(['own@local-test.invalid']);
  });

  it('fails closed: an identity read that throws, or no proved email, sends nothing and does not crash', async () => {
    for (const read of [
      async (): Promise<string | null> => Promise.reject(new Error('identity down')),
      async (): Promise<string | null> => null,
    ]) {
      const email = new SentEmail();
      const report = await dispatcher(email, { provedAccountEmail: read }).dispatch(promo());
      expect(email.sent).toEqual([]);
      // Non-critical with no address: no email row, as for a person who gave no address.
      expect(report.outcomes.map((o) => o.channel)).toEqual(['inapp']);
    }
  });

  it('a critical message with an unreadable account email records channel.no_target', async () => {
    const email = new SentEmail();
    const report = await dispatcher(email, { provedAccountEmail: async () => Promise.reject(new Error('down')) }).dispatch(
      promo({ kind: 'bank.margin_call', severity: 'critical' }),
    );
    expect(email.sent).toEqual([]);
    expect(report.outcomes.find((o) => o.channel === 'email')).toMatchObject({ status: 'refused', code: 'channel.no_target' });
  });

  it('respects the category choice: promotions email off mails nothing', async () => {
    const store = new MemoryCategoryPrefStore();
    const categories = new CategoryPrefs(store, {} as CommandLog, () => []);
    const planOutOfApp: DispatchOptions['planOutOfApp'] = async (input) =>
      (await categories.allows(input.userId, input.kind, input.channel)) ? 'send' : 'muted';
    const options = { provedAccountEmail: async () => 'pfn@local-test.invalid', planOutOfApp };

    const on = new SentEmail();
    await dispatcher(on, options).dispatch(promo());
    expect(on.sent).toHaveLength(1);

    await store.set(USER, 'promotions', 'email', false);
    const off = new SentEmail();
    const report = await dispatcher(off, options).dispatch(promo({ id: '44444444-4444-4444-8444-444444444444' }));
    expect(off.sent).toEqual([]);
    expect(report.outcomes.find((o) => o.channel === 'email')).toMatchObject({ status: 'refused', code: 'channel.muted' });
  });

  it('never asks identity while the email channel cannot send (no sender: production unchanged)', async () => {
    let asked = 0;
    const read = async () => {
      asked += 1;
      return 'pfn@local-test.invalid';
    };
    const unconfigured = new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']);
    const report = await dispatcher(unconfigured, { provedAccountEmail: read }).dispatch(promo());
    expect(asked).toBe(0);
    expect(report.outcomes.map((o) => o.channel)).toEqual(['inapp']);
  });
});

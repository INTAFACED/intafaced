import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NotificationChannel, OutboundMessage } from '../channels/channel.js';
import { InAppChannel, UnconfiguredChannel } from '../channels/gateway.js';
import { ChannelRegistry, channelsFromEnv } from '../channels/registry.js';
import { testEmailOutbox } from '../channels/test-outbox.js';
import { MemoryDeliveryStore, MemoryTargetStore } from '../channel-store.js';
import { NotificationDispatcher } from '../dispatch.js';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertService } from './service.js';
import { MemoryAlertStore } from './store.js';
import { TEST_ALERT_LIMITS } from './test-limits.js';
import type { MarkSource, PriceAlert } from './types.js';
import { MemoryAlertWebhookStore, NO_WEBHOOK_POLICY, runWebhookTick, type AlertWebhookPolicy, type Resolve } from './webhook.js';

/**
 * J-charts-desk-10: an alert reaches the person on the channels they chose for it, and nowhere else.
 *   #1 in-app and email, no email sender: the in-app row is written and the email row says why it did not go; nothing reads as emailed.
 *   #2 push, no push gateway: the same, naming push.
 *   #3 a webhook: one POST per firing, logged; a firing replayed after a crash posts nothing new.
 *   #5 the TEST email stand-in set: one email, labelled TEST, with the market, level and time; the replayed firing sends none.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const BTC = '22222222-2222-4222-8222-222222222222';
const publicHost: Resolve = async () => [{ address: '93.184.216.34', family: 4 }];
const POLICY: AlertWebhookPolicy = { ports: [443], retrySeconds: [5], testLoopback: false, timeoutMs: 1000 };

function marks(price: string): MarkSource {
  return {
    kind: 'live',
    async quote() {
      return { kind: 'ok', price, at: new Date() };
    },
    async marketIdsBySymbol() {
      return new Map([['BTC/USDT', BTC]]);
    },
  };
}

class SentEmail implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason = null;
  readonly sent: OutboundMessage[] = [];
  async deliver(req: OutboundMessage) {
    this.sent.push(req);
    return { reference: `ref-${this.sent.length}` };
  }
}

async function harness(opts: { email?: NotificationChannel; confirmedEmail?: boolean; price?: string } = {}) {
  const registry = new ChannelRegistry([
    new InAppChannel(),
    opts.email ?? new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
  const targets = new MemoryTargetStore();
  if (opts.confirmedEmail) {
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'person@example.test',
      locale: 'en',
      verifyTokenHash: 'h',
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    await targets.markVerified(USER, 'email', 'h', new Date());
  }
  const deliveries = new MemoryDeliveryStore();
  const store = new MemoryNotifyStore();
  const dispatcher = new NotificationDispatcher(registry, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: true });
  const notify = new NotifyService(store, { fanoutEnabled: true }, { targets, deliveries, channels: registry, dispatcher });
  const webhooks = new MemoryAlertWebhookStore();
  const alertStore = new MemoryAlertStore();
  const alerts = new AlertService(
    alertStore,
    marks(opts.price ?? '101'),
    notify,
    undefined,
    { ...TEST_ALERT_LIMITS, triggerLogDays: 7 },
    undefined,
    {
      webhooks,
      policy: POLICY,
      resolve: publicHost,
    },
  );
  return { alerts, alertStore, deliveries, webhooks, notify };
}

const rule = { userId: USER, marketId: BTC, direction: 'above' as const, targetPrice: '100' };

describe('per-alert channels', () => {
  it('#1 in-app and email with no email sender: the in-app row is written, the email is refused vendor-less, never accepted', async () => {
    const h = await harness();
    const alert = await h.alerts.create({ ...rule, channels: ['email'] });
    expect(alert.channels).toEqual(['email']);
    await h.alerts.evaluateDueAlerts();
    const { triggers } = await h.alerts.triggers(USER, { limit: 10 });
    expect(triggers).toHaveLength(1);
    const delivery = (await h.alerts.triggerDeliveries(USER, triggers)).get(`${alert.id}:1`)!;
    const byChannel = Object.fromEntries(delivery.channels.map((d) => [d.channel, d]));
    expect(byChannel.inapp).toMatchObject({ status: 'accepted' });
    expect(byChannel.email).toMatchObject({
      status: 'refused',
      refusalCode: 'channel.not_configured',
      acceptedAt: null,
      attemptedAt: null,
    });
    expect(Object.keys(byChannel).sort()).toEqual(['email', 'inapp']);
    expect(delivery.webhook).toBeNull();
  });

  it('#2 push with no push gateway: refused channel.not_configured on the push row', async () => {
    const h = await harness();
    const alert = await h.alerts.create({ ...rule, channels: ['email', 'push'] });
    await h.alerts.evaluateDueAlerts();
    const { triggers } = await h.alerts.triggers(USER, { limit: 10 });
    const delivery = (await h.alerts.triggerDeliveries(USER, triggers)).get(`${alert.id}:1`)!;
    expect(delivery.channels.find((d) => d.channel === 'push')).toMatchObject({ status: 'refused', refusalCode: 'channel.not_configured' });
  });

  it('an alert for in-app only sends no email, even where the person has a confirmed address', async () => {
    const email = new SentEmail();
    const h = await harness({ email, confirmedEmail: true });
    await h.alerts.create({ ...rule, channels: [] });
    await h.alerts.evaluateDueAlerts();
    expect(email.sent).toHaveLength(0);
  });

  it('an alert made before the choice existed (channels null) follows the settings: a confirmed address is emailed', async () => {
    const email = new SentEmail();
    const h = await harness({ email, confirmedEmail: true });
    const alert = await h.alerts.create(rule);
    expect(alert.channels).toBeNull();
    await h.alerts.evaluateDueAlerts();
    expect(email.sent).toHaveLength(1);
  });

  it('refuses a channel that is not offered for alerts', async () => {
    const h = await harness();
    await expect(h.alerts.create({ ...rule, channels: ['sms' as never] })).rejects.toMatchObject({ code: 'alert.channel_invalid' });
  });

  it('#5 with an email sender: one email holding the market by symbol, the level and the time; a replayed firing sends none', async () => {
    const email = new SentEmail();
    const h = await harness({ email, confirmedEmail: true });
    const alert = await h.alerts.create({ ...rule, channels: ['email'] });
    await h.alerts.evaluateDueAlerts();
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.address).toBe('person@example.test');
    expect(email.sent[0]!.body).toMatch(/^BTC\/USDT crossed above 100 \(mark 101\) at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\./);
    // The same firing again, as a sweep that crashed after the inbox write would replay it: the same key, no second email.
    const fired = await h.alertStore.get(USER, alert.id);
    rearm(h.alertStore, { ...fired!, status: 'active', firedAt: null });
    await h.alerts.evaluateDueAlerts();
    expect(email.sent).toHaveLength(1);
  });
});

/** Puts a fired alert back to active in the memory store, as a sweep that crashed after the inbox write would find it. */
function rearm(store: MemoryAlertStore, alert: PriceAlert): void {
  const byId: unknown = Reflect.get(store, 'byId');
  if (!(byId instanceof Map)) throw new Error('the memory alert store keeps its alerts in byId');
  byId.set(alert.id, alert);
}

describe('webhook', () => {
  it('refuses to save a webhook while the owner ports are blank', async () => {
    const h = await harness();
    const blank = new AlertService(
      new MemoryAlertStore(),
      marks('101'),
      h.notify,
      undefined,
      { ...TEST_ALERT_LIMITS, triggerLogDays: 7 },
      undefined,
      {
        webhooks: new MemoryAlertWebhookStore(),
        policy: NO_WEBHOOK_POLICY,
        resolve: publicHost,
      },
    );
    await expect(blank.create({ ...rule, webhookUrl: 'https://hooks.example.com/' })).rejects.toMatchObject({
      code: 'notify.alert_webhook_ports_unset',
    });
  });

  it('refuses to save a webhook to a private address; nothing is stored', async () => {
    const h = await harness();
    const privateHost: Resolve = async () => [{ address: '10.0.0.1', family: 4 }];
    const alerts = new AlertService(
      h.alertStore,
      marks('101'),
      h.notify,
      undefined,
      { ...TEST_ALERT_LIMITS, triggerLogDays: 7 },
      undefined,
      {
        webhooks: h.webhooks,
        policy: POLICY,
        resolve: privateHost,
      },
    );
    await expect(alerts.create({ ...rule, webhookUrl: 'https://hooks.example.com/' })).rejects.toMatchObject({
      code: 'alert.webhook_private_address',
    });
    expect(await h.alertStore.list(USER)).toHaveLength(0);
  });

  it('#3 a firing queues one webhook delivery with the alert body; a replay queues nothing new; the worker posts once', async () => {
    const h = await harness();
    const alert = await h.alerts.create({ ...rule, webhookUrl: 'https://hooks.example.com/alerts' });
    expect(alert.webhookUrl).toBe('https://hooks.example.com/alerts');
    await h.alerts.evaluateDueAlerts();
    const fired = await h.alertStore.get(USER, alert.id);
    rearm(h.alertStore, { ...fired!, status: 'active', firedAt: null });
    await h.alerts.evaluateDueAlerts();
    expect(h.webhooks.rows.size).toBe(1);
    const posted: string[] = [];
    await runWebhookTick(h.webhooks, async (_url, body) => (posted.push(body), { status: 200, cause: 'ok' }), POLICY);
    await runWebhookTick(h.webhooks, async (_url, body) => (posted.push(body), { status: 200, cause: 'ok' }), POLICY);
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!)).toMatchObject({
      type: 'alert.fired',
      alertId: alert.id,
      fireNumber: 1,
      market: 'BTC/USDT',
      marketId: BTC,
      condition: 'greater_than',
      targetPrice: '100',
      markPrice: '101',
    });
    const { triggers } = await h.alerts.triggers(USER, { limit: 10 });
    const delivery = (await h.alerts.triggerDeliveries(USER, triggers)).get(`${alert.id}:1`)!;
    expect(delivery.webhook).toMatchObject({
      status: 'delivered',
      attempts: [expect.objectContaining({ n: 1, status: 200, cause: 'ok' })],
    });
  });

  it('a watchlist alert never carries a webhook or its own channels', async () => {
    const h = await harness();
    const many = await h.alerts.createMany({
      userId: USER,
      marketIds: [BTC],
      direction: 'above',
      targetPrice: '100',
      webhookUrl: 'https://10.0.0.1/',
      channels: ['email'],
    } as never);
    expect(many[0]).toMatchObject({ webhookUrl: null, channels: null });
  });
});

describe('the TEST email stand-in', () => {
  it('writes each email as a LOCAL-TEST line labelled TEST, and only on a dev or test stack', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'notify-outbox-'));
    const file = path.join(dir, 'mail.log');
    const registry = channelsFromEnv({ NOTIFY_EMAIL_TEST_OUTBOX: file, APP_ENV: 'test' } as never);
    const email = registry.get('email');
    expect(email.unavailableReason).toBeNull();
    // Nothing to probe: the person can add and confirm an address through it, as the settings page reads this status.
    expect(registry.status().find((c) => c.channel === 'email')).toMatchObject({ configured: true, available: true, reason: null });
    expect(registry.status().find((c) => c.channel === 'push')).toMatchObject({ configured: false, available: false });
    await email.deliver({
      notificationId: 'n1',
      userId: USER,
      channel: 'email',
      kind: 'alert.price.crossed',
      severity: 'action',
      titleKey: 't',
      bodyKey: 'b',
      title: 'Price alert',
      body: 'BTC/USDT crossed above 100 (mark 101) at 2026-11-14 04:00:00 UTC.',
      href: '/markets/x',
      locale: 'en',
      address: 'person@example.test',
      idempotencyKey: 'n1:email',
    });
    const [line] = readFileSync(file, 'utf8').trim().split('\n');
    expect(line!.startsWith('LOCAL-TEST ')).toBe(true);
    const mail = JSON.parse(line!.slice('LOCAL-TEST '.length));
    expect(mail).toMatchObject({ to: 'person@example.test', subject: 'TEST · Price alert', idempotencyKey: 'n1:email' });
    expect(mail.text).toContain('TEST');
    expect(mail.text).toContain('BTC/USDT crossed above 100');
    expect(() => testEmailOutbox(file, 'prod')).toThrow(/APP_ENV/);
    expect(() => testEmailOutbox('relative.log', 'test')).toThrow(/absolute/);
    expect(() => channelsFromEnv({ NOTIFY_EMAIL_TEST_OUTBOX: file, APP_ENV: 'staging' } as never)).toThrow(/APP_ENV/);
  });

  it('a configured email gateway wins over the stand-in', () => {
    const registry = channelsFromEnv({
      NOTIFY_EMAIL_GATEWAY_URL: 'https://mail.example.test/send',
      NOTIFY_EMAIL_GATEWAY_TOKEN: 'token',
      NOTIFY_EMAIL_TEST_OUTBOX: '/tmp/never.log',
      APP_ENV: 'test',
    } as never);
    expect(registry.get('email').constructor.name).toBe('EmailChannel');
  });
});

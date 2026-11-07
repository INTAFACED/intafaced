/**
 * J-charts-desk-10: how an alert reaches the person. The channel choice, the webhook URL check (public https; a local TEST
 * receiver only behind its switch), the published retry policy, and the delivery log with retries.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { PriceAlert } from './types.js';
import {
  AlertWebhookDelivery,
  MemoryAlertDeliveryStore,
  assertChannelChoice,
  isLocalTestReceiver,
  parseBackoff,
  webhookBody,
  webhookPolicy,
  webhookTargetCheck,
} from './webhooks.js';

const POLICY = webhookPolicy(3, [5_000, 10_000])!;
const publicOnly = webhookTargetCheck({ allowLocalTestReceiver: false, resolve: async () => ['93.184.216.34'] });
const withLocal = webhookTargetCheck({ allowLocalTestReceiver: true, resolve: async () => ['93.184.216.34'] });

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'u1',
  marketId: 'm-btc',
  kind: 'price',
  direction: 'below',
  targetPrice: '70000.00',
  status: 'active',
  firedAt: null,
  createdAt: new Date('2026-11-07T09:00:00Z'),
  condition: 'less_than',
  name: 'TEST webhook',
  message: 'TEST: dipped',
  expiresAt: null,
  lastSide: null,
  frequency: 'once',
  fireCount: 0,
  lastFiredAt: null,
  stopReason: null,
  burstStartedAt: null,
  burstCount: 0,
  extras: [],
  updatedAt: new Date('2026-11-07T09:00:00Z'),
  source: 'mark',
  ...over,
});

describe('the retry policy', () => {
  it('is the owner values, and nothing when either is blank or they disagree', () => {
    expect(webhookPolicy(3, [5_000, 10_000])).toEqual({ maxAttempts: 3, backoffMs: [5_000, 10_000] });
    expect(webhookPolicy(1, [])).toEqual({ maxAttempts: 1, backoffMs: [] });
    expect(webhookPolicy(undefined, [5_000])).toBeNull();
    expect(webhookPolicy(3, null)).toBeNull();
    expect(webhookPolicy(3, [5_000])).toBeNull();
    expect(webhookPolicy(2, [0])).toBeNull();
  });
  it('reads the waits as written, and nothing for a blank or malformed list', () => {
    expect(parseBackoff('5000, 10000')).toEqual([5_000, 10_000]);
    expect(parseBackoff('')).toBeNull();
    expect(parseBackoff(undefined)).toBeNull();
    expect(parseBackoff('5s,10s')).toBeNull();
  });
});

describe('the channel choice', () => {
  it('always keeps in-app, each channel once, in a fixed order', async () => {
    expect(await assertChannelChoice({ channels: ['email', 'push', 'email'] }, POLICY, publicOnly)).toEqual({
      channels: ['inapp', 'email', 'push'],
      webhookUrl: null,
    });
    expect(await assertChannelChoice({}, POLICY, publicOnly)).toEqual({ channels: ['inapp'], webhookUrl: null });
  });
  it('refuses an unknown channel, a webhook with no URL, and a webhook while the policy is blank', async () => {
    await expect(assertChannelChoice({ channels: ['fax'] }, POLICY, publicOnly)).rejects.toMatchObject({ code: 'alert.channel_unknown' });
    await expect(assertChannelChoice({ channels: ['webhook'] }, POLICY, publicOnly)).rejects.toMatchObject({
      code: 'alert.webhook_url_missing',
    });
    await expect(
      assertChannelChoice({ channels: ['webhook'], webhookUrl: 'https://hooks.example.com/x' }, null, publicOnly),
    ).rejects.toMatchObject({ code: 'notify.alert_webhook_policy_unset' });
  });
  it('takes a public https URL and refuses http, private addresses and loopback while the TEST switch is off', async () => {
    expect(await assertChannelChoice({ channels: ['webhook'], webhookUrl: ' https://hooks.example.com/x ' }, POLICY, publicOnly)).toEqual({
      channels: ['inapp', 'webhook'],
      webhookUrl: 'https://hooks.example.com/x',
    });
    for (const url of [
      'http://hooks.example.com/x',
      'https://10.0.0.5/x',
      'https://127.0.0.1/x',
      'http://127.0.0.1:4000/x',
      'https://localhost/x',
    ]) {
      await expect(assertChannelChoice({ channels: ['webhook'], webhookUrl: url }, POLICY, publicOnly)).rejects.toMatchObject({
        code: 'alert.webhook_url_refused',
      });
    }
  });
  it('lets a loopback TEST receiver through only behind the switch, and nothing else private', async () => {
    expect(await withLocal('http://127.0.0.1:4000/hook')).toBeNull();
    expect(await withLocal('http://localhost:4000/hook')).toBeNull();
    expect(await withLocal('http://10.0.0.5/hook')).not.toBeNull();
    expect(await withLocal('http://user:pw@127.0.0.1:4000/hook')).not.toBeNull();
    expect(isLocalTestReceiver('ftp://127.0.0.1/x')).toBe(false);
  });
});

describe('the webhook body', () => {
  it('names the alert, the market, the level, the price it fired at and the message', () => {
    const body = JSON.parse(
      webhookBody(alert(), {
        seq: 1,
        markPrice: '69000.5',
        at: new Date('2026-11-07T09:01:00Z'),
        market: 'BTC/USDT',
        message: 'TEST: dipped',
      }),
    );
    expect(body).toEqual({
      type: 'alert.triggered',
      alertId: alert().id,
      trigger: 1,
      market: 'BTC/USDT',
      marketId: 'm-btc',
      condition: 'less_than',
      targetPrice: '70000.00',
      price: '69000.5',
      name: 'TEST webhook',
      message: 'TEST: dipped',
      firedAt: '2026-11-07T09:01:00.000Z',
    });
  });
});

describe('delivery', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = null;
  });
  async function receiver(status: number) {
    const hits: { body: string; type: string | undefined }[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        hits.push({ body: Buffer.concat(chunks).toString('utf8'), type: req.headers['content-type'] });
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return { hits, url: `http://127.0.0.1:${address.port}/hook` };
  }
  const choice = (url: string) => ({ channels: ['inapp', 'webhook'] as const, webhookUrl: url });

  it('POSTs one trigger once, as JSON, logs it delivered with its status, and never sends it again', async () => {
    const { hits, url } = await receiver(200);
    const store = new MemoryAlertDeliveryStore();
    const hooks = new AlertWebhookDelivery(store, POLICY, { allowLocalTestReceiver: true, timeoutMs: 2_000 });
    const t0 = new Date();
    await hooks.queue(alert(), choice(url), 1, '{"a":1}', t0);
    await hooks.queue(alert(), choice(url), 1, '{"a":1}', t0);
    expect(await hooks.tick(new Date(t0.getTime() + 1))).toEqual({ delivered: 1, failed: 0 });
    expect(await hooks.tick(new Date(t0.getTime() + 60_000))).toEqual({ delivered: 0, failed: 0 });
    expect(hits).toEqual([{ body: '{"a":1}', type: 'application/json' }]);
    expect(await store.attempts('u1')).toMatchObject([{ attempt: 1, status: 'delivered', httpStatus: 200, error: null }]);
  });

  it('retries a failing endpoint after each published wait, up to the last attempt, logging every answer', async () => {
    const { hits, url } = await receiver(500);
    const store = new MemoryAlertDeliveryStore();
    const hooks = new AlertWebhookDelivery(store, POLICY, { allowLocalTestReceiver: true, timeoutMs: 2_000 });
    const t0 = Date.now();
    await hooks.queue(alert(), choice(url), 1, '{"a":1}', new Date(t0));
    await hooks.tick(new Date(t0));
    // The retry is not due before its wait.
    expect(await hooks.tick(new Date(Date.now() + 1_000))).toEqual({ delivered: 0, failed: 0 });
    await hooks.tick(new Date(Date.now() + 5_100));
    await hooks.tick(new Date(Date.now() + 5_100 + 10_100));
    await hooks.tick(new Date(Date.now() + 60_000));
    expect(hits).toHaveLength(3);
    const log = await store.attempts('u1');
    expect(log.map((a) => [a.attempt, a.status, a.httpStatus])).toEqual([
      [1, 'failed', 500],
      [2, 'failed', 500],
      [3, 'failed', 500],
    ]);
    expect(log[1]!.dueAt.getTime() - log[0]!.attemptedAt!.getTime()).toBe(5_000);
    expect(log[2]!.dueAt.getTime() - log[1]!.attemptedAt!.getTime()).toBe(10_000);
  });

  it('refuses a loopback URL when the switch is off, and logs why', async () => {
    const { hits, url } = await receiver(200);
    const store = new MemoryAlertDeliveryStore();
    const hooks = new AlertWebhookDelivery(store, webhookPolicy(1, [])!, { allowLocalTestReceiver: false, timeoutMs: 2_000 });
    await hooks.queue(alert(), choice(url), 1, '{}', new Date());
    await hooks.tick(new Date(Date.now() + 1));
    expect(hits).toHaveLength(0);
    expect(await store.attempts('u1')).toMatchObject([
      { status: 'failed', httpStatus: null, error: 'notify.alert_webhook_target_refused' },
    ]);
  });

  it('queues nothing for an alert without the webhook channel, or while the policy is blank', async () => {
    const store = new MemoryAlertDeliveryStore();
    await new AlertWebhookDelivery(store, POLICY, { allowLocalTestReceiver: true, timeoutMs: 1 }).queue(
      alert(),
      { channels: ['inapp', 'email'], webhookUrl: null },
      1,
      '{}',
      new Date(),
    );
    await new AlertWebhookDelivery(store, null, { allowLocalTestReceiver: true, timeoutMs: 1 }).queue(
      alert(),
      choice('http://127.0.0.1:1/x'),
      1,
      '{}',
      new Date(),
    );
    expect(await store.attempts('u1')).toEqual([]);
  });
});

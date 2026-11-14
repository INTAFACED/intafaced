import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MerchantWebhookService, PostgresMerchantWebhookStore, WEBHOOK_CLAIM_LEASE_MS } from './merchant-webhooks.js';
import type { PaymentView } from './payment-service.js';
import { signPayload } from './rails/webhook-signature.js';
import type { PinnedPostRequest, WebhookTransport } from './webhook-pinned-post.js';
import type { WebhookResolver } from './webhook-url-guard.js';

/**
 * J-developer-10 on the durable store: subscriptions filter the fan-out, every attempt is journalled with the row's
 * new state, an overlapping roll signs twice, and an `unknown` outcome keeps its lease against a second worker.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('pay_webhook_attempts')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const resolver: WebhookResolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('merchant webhook attempts on Postgres (J-developer-10)', () => {
  let stop = async () => undefined as void;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  let merchantId = '';
  let at = Date.parse('2026-11-14T10:00:00.000Z');
  const now = () => new Date(at);

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchantId = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${randomUUID()}) RETURNING id`)[0]!.id;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 60_000);

  const payment = (over: Partial<PaymentView> = {}): PaymentView =>
    ({
      id: randomUUID(),
      merchantId,
      profileId: null,
      amount: parseAmount('10'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      railRef: 'ref',
      status: 'captured',
      capturedAmount: parseAmount('10'),
      refundedAmount: parseAmount('0'),
      createdAt: new Date('2026-11-14T09:00:00.000Z'),
      ...over,
    }) as PaymentView;

  const worker = (script: Array<number | 'hang'>, posts: PinnedPostRequest[]) => {
    const transport: WebhookTransport = async (req) => {
      posts.push(req);
      const next = script.shift() ?? 200;
      if (next === 'hang') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      return { status: next };
    };
    return new MerchantWebhookService(new PostgresMerchantWebhookStore(sql), {
      now,
      transport,
      resolver,
      retryScheduleSeconds: [5, 10, 20],
    });
  };

  async function endpoint(eventTypes: string[]): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO pay.merchant_webhook_endpoints (id, merchant_id, url, secret_hash, signing_secret, event_types)
      VALUES (${id}, ${merchantId}, 'https://receiver.merchant.example/hook', 'hash', ${'a'.repeat(64)}, ${eventTypes}::text[])`;
    return id;
  }

  it('fans out only to subscribed endpoints, journals 500 then 200, and ends delivered with the same body', async () => {
    await sql`UPDATE pay.merchant_webhook_endpoints SET status = 'disabled'`;
    const subscribed = await endpoint(['payment.authorized', 'payment.captured']);
    const posts: PinnedPostRequest[] = [];
    const svc = worker([500, 200], posts);
    expect(await svc.enqueue({ type: 'payment.refunded', payment: payment({ refundedAmount: parseAmount('1') }) })).toBe(0);
    expect(await svc.enqueue({ type: 'payment.captured', payment: payment() })).toBe(1);
    expect((await svc.processDue(25)).failed).toBe(1);
    at += 5_000;
    expect((await svc.processDue(25)).delivered).toBe(1);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toBe(posts[0]!.body);
    expect(posts[1]!.headers['x-intafaced-signature']).not.toBe(posts[0]!.headers['x-intafaced-signature']);
    const rows = await sql<Array<{ id: string; status: string; attempts: number; resend_request_id: string | null }>>`
      SELECT id, status, attempts, resend_request_id FROM pay.merchant_webhook_deliveries WHERE endpoint_id = ${subscribed}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'delivered', attempts: 2, resend_request_id: null });
    const journal = await sql<Array<{ attempt_no: number; outcome: string; status_code: number | null }>>`
      SELECT attempt_no, outcome, status_code FROM pay.merchant_webhook_attempts WHERE delivery_id = ${rows[0]!.id} ORDER BY attempt_no`;
    expect(journal).toEqual([
      { attempt_no: 1, outcome: 'failed', status_code: 500 },
      { attempt_no: 2, outcome: 'delivered', status_code: 200 },
    ]);
  });

  it('signs with both secrets while an overlap runs, then only the new one', async () => {
    await sql`UPDATE pay.merchant_webhook_endpoints SET status = 'disabled'`;
    const id = await endpoint(['payment.captured']);
    await sql`
      UPDATE pay.merchant_webhook_endpoints
         SET previous_signing_secret = signing_secret, previous_secret_until = ${new Date(at + 30_000)}, signing_secret = ${'b'.repeat(64)}
       WHERE id = ${id}`;
    const posts: PinnedPostRequest[] = [];
    const svc = worker([200, 200], posts);
    await svc.enqueue({ type: 'payment.captured', payment: payment() });
    await svc.processDue(25);
    const first = posts[0]!;
    const ts = first.headers['x-intafaced-timestamp']!;
    expect(first.headers['x-intafaced-signature']).toBe(
      `${signPayload('b'.repeat(64), ts, first.body)},${signPayload('a'.repeat(64), ts, first.body)}`,
    );
    at += 31_000;
    await svc.enqueue({ type: 'payment.captured', payment: payment() });
    await svc.processDue(25);
    const second = posts[1]!;
    expect(second.headers['x-intafaced-signature']).toBe(
      signPayload('b'.repeat(64), second.headers['x-intafaced-timestamp']!, second.body),
    );
  });

  it('a timeout is unknown, and a second worker does not claim it while the lease holds', async () => {
    await sql`UPDATE pay.merchant_webhook_endpoints SET status = 'disabled'`;
    const id = await endpoint(['payment.captured']);
    const posts: PinnedPostRequest[] = [];
    const first = worker(['hang'], posts);
    await first.enqueue({ type: 'payment.captured', payment: payment() });
    expect((await first.processDue(25)).unknown).toBe(1);
    const [row] = await sql<Array<{ id: string; status: string }>>`
      SELECT id, status FROM pay.merchant_webhook_deliveries WHERE endpoint_id = ${id}`;
    expect(row!.status).toBe('unknown');
    const second = worker([200], posts);
    at += WEBHOOK_CLAIM_LEASE_MS - 1_000;
    expect((await second.processDue(25)).delivered).toBe(0);
    expect(posts).toHaveLength(1);
    at += 1_000;
    expect((await second.processDue(25)).delivered).toBe(1);
    expect(posts).toHaveLength(2);
    const outcomes = await sql<Array<{ outcome: string }>>`
      SELECT outcome FROM pay.merchant_webhook_attempts WHERE delivery_id = ${row!.id} ORDER BY attempt_no`;
    expect(outcomes.map((o) => o.outcome)).toEqual(['unknown', 'delivered']);
  });

  it('a 410 disables the endpoint as receiver_gone', async () => {
    await sql`UPDATE pay.merchant_webhook_endpoints SET status = 'disabled'`;
    const id = await endpoint(['payment.captured']);
    const svc = worker([410], []);
    await svc.enqueue({ type: 'payment.captured', payment: payment() });
    expect((await svc.processDue(25)).disabled).toBe(1);
    const [ep] = await sql<Array<{ status: string; disabled_reason: string }>>`
      SELECT status, disabled_reason FROM pay.merchant_webhook_endpoints WHERE id = ${id}`;
    expect(ep).toEqual({ status: 'disabled', disabled_reason: 'receiver_gone' });
  });

  it('a resend request id names at most one attempt per delivery', async () => {
    await sql`UPDATE pay.merchant_webhook_endpoints SET status = 'disabled'`;
    const id = await endpoint(['payment.captured']);
    const svc = worker([200, 200], []);
    await svc.enqueue({ type: 'payment.captured', payment: payment() });
    await svc.processDue(25);
    const [row] = await sql<Array<{ id: string }>>`SELECT id FROM pay.merchant_webhook_deliveries WHERE endpoint_id = ${id}`;
    const requestId = randomUUID();
    await sql`
      UPDATE pay.merchant_webhook_deliveries SET status = 'pending', next_attempt_at = ${now()}, resend_request_id = ${requestId}
       WHERE id = ${row!.id}`;
    await svc.processDue(25);
    const tagged = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.merchant_webhook_attempts WHERE delivery_id = ${row!.id} AND resend_request_id = ${requestId}`;
    expect(tagged[0]!.n).toBe(1);
    await expect(
      sql`
        INSERT INTO pay.merchant_webhook_attempts (delivery_id, merchant_id, attempt_no, started_at, finished_at, outcome, resend_request_id)
        VALUES (${row!.id}, ${merchantId}, 9, now(), now(), 'delivered', ${requestId})`,
    ).rejects.toThrow(/merchant_webhook_attempts_resend_uq/);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { SubscriptionService } from './subscription-service.js';

/** M-bill-01 collection method against a real Postgres. */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const c = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_collection_method_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: c.getConnectionUri(), stop: async () => void (await c.stop()) };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code: string }).code;
  }
  throw new Error('expected a refusal');
}

describe('M-bill-01 setCollectionMethod (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let subs!: SubscriptionService;
  let merchantId = '';
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    const pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
    merchantId = (await pay.createMerchant({ userId: 'owner-collection', pricing: { feeBps: 0 } })).id;
    subs = new SubscriptionService(
      sql,
      () => new Date(),
      async () => {
        throw new Error('no invoice is opened in this suite');
      },
    );
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  async function subscription(path: 'crypto_invoice' | 'card') {
    const mandate = await subs.createMandate({
      merchantId,
      customerId: 'cust-1',
      assetId: 'USDT',
      amount: amt('10'),
      ceiling: null,
      cadence: 'monthly',
      startsAt: new Date('2030-01-01T00:00:00Z'),
      endsAt: null,
    });
    return subs.createSubscription({ mandateId: mandate.id, path });
  }

  it('charge automatically refuses rail absent and the method stays send invoice (billing-tax-003)', async () => {
    const sub = await subscription('crypto_invoice');
    expect(await codeOf(subs.setCollectionMethod(sub.id, 'charge_automatically'))).toBe('pay.mandate_rail_absent');
    expect((await subs.getSubscription(sub.id)).path).toBe('crypto_invoice');
  });

  it('send invoice on a send-invoice subscription returns it unchanged, twice the same', async () => {
    const sub = await subscription('crypto_invoice');
    const a = await subs.setCollectionMethod(sub.id, 'send_invoice');
    const b = await subs.setCollectionMethod(sub.id, 'send_invoice');
    expect(a).toEqual(sub);
    expect(b).toEqual(sub);
  });

  it('send invoice moves a card subscription onto the crypto invoice path', async () => {
    const sub = await subscription('card');
    const moved = await subs.setCollectionMethod(sub.id, 'send_invoice');
    expect(moved.path).toBe('crypto_invoice');
    expect(moved.status).toBe(sub.status);
    expect(moved.nextRunAt).toEqual(sub.nextRunAt);
  });

  it('a suspended merchant cannot move a card subscription onto crypto invoice; the path stays card', async () => {
    const sub = await subscription('card');
    await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${merchantId}`;
    try {
      expect(await codeOf(subs.setCollectionMethod(sub.id, 'send_invoice'))).toBe('pay.merchant_inactive');
      expect((await subs.getSubscription(sub.id)).path).toBe('card');
    } finally {
      await sql`UPDATE pay.merchants SET status = 'active' WHERE id = ${merchantId}`;
    }
  });

  it('a KYB-rejected merchant cannot move a card subscription onto crypto invoice; the path stays card', async () => {
    const sub = await subscription('card');
    await sql`UPDATE pay.merchants SET kyb_status = 'rejected' WHERE id = ${merchantId}`;
    try {
      expect(await codeOf(subs.setCollectionMethod(sub.id, 'send_invoice'))).toBe('pay.kyb_required');
      expect((await subs.getSubscription(sub.id)).path).toBe('card');
    } finally {
      await sql`UPDATE pay.merchants SET kyb_status = 'none' WHERE id = ${merchantId}`;
    }
  });

  it('a cancelled subscription refuses with its state; an unknown id is not found', async () => {
    const sub = await subscription('card');
    await subs.cancelSubscription(sub.id);
    expect(await codeOf(subs.setCollectionMethod(sub.id, 'send_invoice'))).toBe('pay.subscription_inactive');
    expect((await subs.getSubscription(sub.id)).path).toBe('card');
    expect(await codeOf(subs.setCollectionMethod('00000000-0000-4000-8000-000000000000', 'send_invoice'))).toBe(
      'pay.subscription_not_found',
    );
  });
});

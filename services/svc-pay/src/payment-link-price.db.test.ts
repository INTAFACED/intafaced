import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db/testing';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayService } from './payment-service.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { RailRegistry } from './rails/registry.js';

/**
 * M-catalogue-03, J-merchant-04 step 2: a payment link made from a catalogue price charges that price's amount and asset,
 * keeps the price for its whole life, and one idempotency key makes one link.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const HASH = '0'.repeat(64);

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_pay_link_price_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('payment link from a catalogue price', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let pay!: PayService;
  let merchantId!: string;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.merchants RESTART IDENTITY CASCADE');
    const ledger = new MemoryLedger();
    const rails = new RailRegistry([
      new CardSandboxAdapter({ secret: 'svc-pay-test-secret-at-least-32-characters', toleranceSeconds: 300 }),
    ]);
    pay = new PayService(sql, ledger, rails, {
      checkoutRiskBand: 'low',
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
      checkoutPublicBasePath: '/api/pay',
    });
    merchantId = (await pay.createMerchant({ userId: OWNER, pricing: { feeBps: 250 } })).id;
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function product(merchant: string, options: { mode?: 'live' | 'test' } = {}): Promise<string> {
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO pay.catalog_products (merchant_id, mode, product_key, request_id, request_hash, name, type, created_by)
      VALUES (${merchant}, ${options.mode ?? 'live'}, ${`hoodie-${randomUUID().slice(0, 8)}`}, ${randomUUID()}, ${HASH},
              'TEST Hoodie', 'physical', ${OWNER})
      RETURNING id`;
    return row!.id;
  }

  async function price(
    merchant: string,
    productId: string,
    terms: { billing?: 'one_time' | 'monthly'; chosen?: boolean; amount?: string; asset?: string } = {},
  ): Promise<string> {
    const chosen = terms.chosen ?? false;
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO pay.catalog_prices (merchant_id, product_id, request_id, request_hash, billing, kind, asset_id, amount,
                                      min_amount, max_amount, created_by)
      VALUES (${merchant}, ${productId}, ${randomUUID()}, ${HASH}, ${terms.billing ?? 'one_time'},
              ${chosen ? 'customer_chosen' : 'fixed'}, ${terms.asset ?? 'USDC'},
              ${chosen ? null : (terms.amount ?? '25')}::numeric, ${chosen ? '1' : null}::numeric, ${chosen ? '100' : null}::numeric,
              ${OWNER})
      RETURNING id`;
    return row!.id;
  }

  const links = async () => (await pay.listPaymentLinks(merchantId, { limit: 50 })).items;

  it('charges the price’s amount and asset and names the price', async () => {
    const priceId = await price(merchantId, await product(merchantId));
    const created = await pay.createPaymentLink({ merchantId, label: 'TEST Hoodie', priceId, maxUses: 3, idempotencyKey: 'link:hoodie:1' });
    const read = await pay.getPaymentLink(merchantId, created.id);
    expect(read).toMatchObject({ amount: '25.000000000000000000', currency: 'USDC', priceId, maxUses: 3, uses: 0, active: true });
    expect((await links()).map((l) => l.priceId)).toEqual([priceId]);
    expect((await pay.resolvePaymentLink(created.token)).amount).toBe('25.000000000000000000');
  });

  it('makes a link from a price without a key too, in one transaction', async () => {
    const priceId = await price(merchantId, await product(merchantId), { amount: '7.5', asset: 'USDT' });
    const created = await pay.createPaymentLink({ merchantId, label: 'TEST Hoodie', priceId });
    expect(await pay.getPaymentLink(merchantId, created.id)).toMatchObject({ amount: '7.500000000000000000', currency: 'USDT', priceId });
  });

  it('takes an amount and asset sent with the price only when they are the price’s', async () => {
    const priceId = await price(merchantId, await product(merchantId));
    await expect(
      pay.createPaymentLink({
        merchantId,
        label: 'TEST Hoodie',
        priceId,
        amount: parseAmount('24'),
        currency: 'USDC',
        idempotencyKey: 'k1',
      }),
    ).rejects.toMatchObject({ code: 'pay.link_price_terms_differ' });
    await expect(
      pay.createPaymentLink({ merchantId, label: 'TEST Hoodie', priceId, amount: parseAmount('25'), currency: 'USDT' }),
    ).rejects.toMatchObject({ code: 'pay.link_price_terms_differ' });
    expect(await links()).toEqual([]);
    // A refused create gives its key back: the claim rolled back with the link.
    const [claims] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.payment_link_create_idempotency`;
    expect(claims!.n).toBe(0);
    const created = await pay.createPaymentLink({
      merchantId,
      label: 'TEST Hoodie',
      priceId,
      amount: parseAmount('25.00'),
      currency: 'USDC',
      idempotencyKey: 'k1',
    });
    expect((await pay.getPaymentLink(merchantId, created.id)).priceId).toBe(priceId);
  });

  it('refuses a monthly price and a customer-chosen price', async () => {
    const productId = await product(merchantId);
    const monthly = await price(merchantId, productId, { billing: 'monthly' });
    const chosen = await price(merchantId, productId, { chosen: true });
    for (const priceId of [monthly, chosen]) {
      await expect(pay.createPaymentLink({ merchantId, label: 'TEST', priceId, idempotencyKey: `k:${priceId}` })).rejects.toMatchObject({
        code: 'pay.link_price_not_one_time',
      });
    }
    expect(await links()).toEqual([]);
  });

  it('refuses an archived price, an archived product, another business’s price and a test-catalogue price', async () => {
    const productId = await product(merchantId);
    const archivedPrice = await price(merchantId, productId);
    await sql`UPDATE pay.catalog_prices SET status = 'archived' WHERE id = ${archivedPrice}`;
    await expect(pay.createPaymentLink({ merchantId, label: 'TEST', priceId: archivedPrice })).rejects.toMatchObject({
      code: 'pay.price_archived',
    });

    const archivedProduct = await product(merchantId);
    const onArchived = await price(merchantId, archivedProduct);
    await sql`UPDATE pay.catalog_products SET status = 'archived', version = version + 1 WHERE id = ${archivedProduct}`;
    await expect(pay.createPaymentLink({ merchantId, label: 'TEST', priceId: onArchived })).rejects.toMatchObject({
      code: 'pay.product_archived',
    });

    const other = (await pay.createMerchant({ userId: OTHER, pricing: { feeBps: 250 } })).id;
    const theirs = await price(other, await product(other));
    await expect(pay.createPaymentLink({ merchantId, label: 'TEST', priceId: theirs, idempotencyKey: 'k:theirs' })).rejects.toMatchObject({
      code: 'pay.price_not_found',
    });

    const testOnly = await price(merchantId, await product(merchantId, { mode: 'test' }));
    await expect(pay.createPaymentLink({ merchantId, label: 'TEST', priceId: testOnly })).rejects.toMatchObject({
      code: 'pay.price_not_found',
    });
    await expect(pay.createPaymentLink({ merchantId, label: 'TEST', priceId: randomUUID() })).rejects.toMatchObject({
      code: 'pay.price_not_found',
    });
    expect(await links()).toEqual([]);
  });

  it('makes one link for one key, sent twice or at once, and refuses the key with another price', async () => {
    const productId = await product(merchantId);
    const priceId = await price(merchantId, productId);
    const input = { merchantId, label: 'TEST Hoodie', priceId, maxUses: 3, idempotencyKey: 'link:hoodie:twice' };
    const [a, b] = await Promise.all([pay.createPaymentLink(input), pay.createPaymentLink(input)]);
    const c = await pay.createPaymentLink(input);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(c.token).toBe(a.token);
    expect(await links()).toHaveLength(1);

    const another = await price(merchantId, productId, { amount: '30' });
    await expect(pay.createPaymentLink({ ...input, priceId: another })).rejects.toMatchObject({ code: 'pay.idempotency_conflict' });
    // The same key without the price is another request too.
    await expect(
      pay.createPaymentLink({ ...input, priceId: undefined, amount: parseAmount('25'), currency: 'USDC' }),
    ).rejects.toMatchObject({ code: 'pay.idempotency_conflict' });
    expect(await links()).toHaveLength(1);
  });

  it('keeps its price after the price is replaced or archived, and the price cannot be moved', async () => {
    const productId = await product(merchantId);
    const priceId = await price(merchantId, productId);
    const created = await pay.createPaymentLink({ merchantId, label: 'TEST Hoodie', priceId, idempotencyKey: 'link:kept' });
    await sql`UPDATE pay.catalog_prices SET status = 'archived' WHERE id = ${priceId}`;
    expect(await pay.getPaymentLink(merchantId, created.id)).toMatchObject({ priceId, amount: '25.000000000000000000' });
    expect((await pay.resolvePaymentLink(created.token)).amount).toBe('25.000000000000000000');
    const another = await price(merchantId, productId, { amount: '30' });
    await expect(sql`UPDATE pay.payment_links SET price_id = ${another} WHERE id = ${created.id}`).rejects.toThrow(
      /a link keeps the price it was made from/,
    );
    await expect(sql`UPDATE pay.payment_links SET price_id = NULL WHERE id = ${created.id}`).rejects.toThrow(
      /a link keeps the price it was made from/,
    );
  });

  it('leaves a link made without a price unchanged', async () => {
    const created = await pay.createPaymentLink({ merchantId, label: 'Invoice 7', amount: parseAmount('12.5'), currency: 'USDT' });
    expect((await pay.getPaymentLink(merchantId, created.id)).priceId).toBeNull();
  });
});

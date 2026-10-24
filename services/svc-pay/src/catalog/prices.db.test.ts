import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createMerchantCatalogRouter } from './router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_prices_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const nid = () => randomUUID();
const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: nid(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: nid(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    const err = error as { code?: string; cause?: { code?: string } };
    return { code: err.code, cause: err.cause?.code };
  }
  throw new Error('expected a refusal');
}

describe('product prices (M-catalogue-02, J-merchant-03 step 3)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = nid();
  const otherOwner = nid();
  const admin = nid();
  const developer = nid();
  const finance = nid();
  const viewer = nid();
  let merchant = '';

  const as = (userId: string, maxBytes: number | null = 100, over: Partial<Principal> = {}) =>
    createMerchantCatalogRouter({ sql, imageRule: { maxBytes } }).createCaller(ctxOf(principalOf(userId, over)));

  beforeAll(async () => {
    const opened = await openAdmin();
    adminStop = opened.stop;
    db = await createTestDatabase({ service: 'pay', url: opened.url, migrations });
    sql = db.sql;
    merchant = (
      await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id, kyb_status) VALUES (${owner}, 'approved') RETURNING id`
    )[0]!.id;
    await sql`INSERT INTO pay.merchants (user_id, kyb_status) VALUES (${otherOwner}, 'approved')`;
    for (const [userId, role] of [
      [admin, 'admin'],
      [developer, 'developer'],
      [finance, 'finance'],
      [viewer, 'viewer'],
    ] as const) {
      await sql`
        INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
        VALUES (${merchant}, ${userId}, ${role}, 'active', ${owner}, now())`;
    }
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });
  const product = async (who = owner, name = 'TEST Poster') =>
    (await as(who).merchantCatalog.products.create({ requestId: nid(), name, type: 'physical' })).product.id;
  const fixed = (productId: string, amount: string, billing: 'one_time' | 'monthly' = 'one_time') => ({
    requestId: nid(),
    productId,
    billing,
    kind: 'fixed' as const,
    assetId: 'USDC',
    amount,
  });
  const chosen = (productId: string, minAmount?: string, maxAmount?: string) => ({
    requestId: nid(),
    productId,
    billing: 'one_time' as const,
    kind: 'customer_chosen' as const,
    assetId: 'USDC',
    ...(minAmount !== undefined ? { minAmount } : {}),
    ...(maxAmount !== undefined ? { maxAmount } : {}),
  });
  const listed = async (productId: string, who = owner) => (await as(who).merchantCatalog.prices.list({ productId, limit: 50 })).items;

  it('makes the first price the default until another is set as default, and never two', async () => {
    const productId = await product();
    expect(await listed(productId, viewer)).toEqual([]);
    const once = (await as(owner).merchantCatalog.prices.create(fixed(productId, '20'))).price;
    expect(once).toMatchObject({ billing: 'one_time', kind: 'fixed', assetId: 'USDC', amount: '20', isDefault: true, createdBy: owner });
    const monthly = (await as(developer).merchantCatalog.prices.create(fixed(productId, '5.50', 'monthly'))).price;
    expect(monthly).toMatchObject({ billing: 'monthly', amount: '5.5', isDefault: false });
    expect((await listed(productId)).map((p) => [p.id, p.isDefault])).toEqual([
      [once.id, true],
      [monthly.id, false],
    ]);

    const moved = await as(admin).merchantCatalog.prices.setDefault({ productId, priceId: monthly.id });
    expect(moved.isDefault).toBe(true);
    expect((await listed(productId)).map((p) => [p.id, p.isDefault])).toEqual([
      [once.id, false],
      [monthly.id, true],
    ]);
    // Setting it again changes nothing, and the database itself refuses a second default.
    expect((await as(owner).merchantCatalog.prices.setDefault({ productId, priceId: monthly.id })).isDefault).toBe(true);
    await expect(sql`UPDATE pay.catalog_prices SET is_default = true WHERE id = ${once.id}`).rejects.toThrow(/catalog_prices_one_default/);
  });

  it('makes exactly one default when a product gets its first prices at once', async () => {
    const productId = await product();
    await Promise.all(['1', '2', '3', '4'].map((amount) => as(owner).merchantCatalog.prices.create(fixed(productId, amount))));
    expect((await listed(productId)).filter((p) => p.isDefault)).toHaveLength(1);
  });

  it('answers a retried create with the price it made, and refuses the same request id with other details', async () => {
    const productId = await product();
    const body = fixed(productId, '20');
    const first = await as(owner).merchantCatalog.prices.create(body);
    expect(await as(owner).merchantCatalog.prices.create({ ...body, amount: '20.00' })).toEqual({ price: first.price, replayed: true });
    expect(await refusal(() => as(owner).merchantCatalog.prices.create({ ...body, amount: '21' }))).toMatchObject({
      code: 'CONFLICT',
      cause: 'pay.request_id_reused',
    });
    const raced = fixed(productId, '7');
    const results = await Promise.all([1, 2, 3].map(() => as(owner).merchantCatalog.prices.create(raced)));
    expect(new Set(results.map((r) => r.price.id)).size).toBe(1);
  });

  it('refuses a fixed price without a positive amount or with bounds, and a customer-chosen one without both bounds', async () => {
    const productId = await product();
    const refused = async (body: Parameters<ReturnType<typeof as>['merchantCatalog']['prices']['create']>[0]) =>
      (await refusal(() => as(owner).merchantCatalog.prices.create(body))).cause;
    const { amount: _none, ...noAmount } = fixed(productId, '1');
    expect(await refused(noAmount)).toBe('pay.price_amount_required');
    expect(await refused(fixed(productId, '0'))).toBe('pay.price_amount_invalid');
    expect(await refused({ ...fixed(productId, '1'), minAmount: '1' })).toBe('pay.price_bounds_not_fixed');
    expect(await refused(chosen(productId, '5'))).toBe('pay.price_bounds_required');
    expect(await refused(chosen(productId, undefined, '5'))).toBe('pay.price_bounds_required');
    expect(await refused(chosen(productId, '10', '5'))).toBe('pay.price_bounds_invalid');
    expect(await refused({ ...chosen(productId, '5', '10'), billing: 'monthly' })).toBe('pay.price_customer_chosen_one_time');
    expect(await refused({ ...chosen(productId, '5', '10'), amount: '7' })).toBe('pay.price_amount_not_chosen');
    expect(await listed(productId)).toEqual([]);
  });

  it('quotes a fixed price as it is, and refuses a customer-chosen amount below its minimum or above its maximum', async () => {
    const productId = await product();
    const flat = (await as(owner).merchantCatalog.prices.create(fixed(productId, '20'))).price;
    const tip = (await as(owner).merchantCatalog.prices.create(chosen(productId, '5', '100'))).price;
    expect(tip).toMatchObject({ kind: 'customer_chosen', amount: null, minAmount: '5', maxAmount: '100', isDefault: false });
    expect(await as(viewer).merchantCatalog.prices.quote({ priceId: flat.id })).toEqual({
      priceId: flat.id,
      assetId: 'USDC',
      amount: '20',
      billing: 'one_time',
    });
    expect((await refusal(() => as(owner).merchantCatalog.prices.quote({ priceId: flat.id, amount: '3' }))).cause).toBe(
      'pay.price_amount_not_chosen',
    );
    expect((await refusal(() => as(owner).merchantCatalog.prices.quote({ priceId: tip.id }))).cause).toBe('pay.price_amount_required');
    expect(await refusal(() => as(finance).merchantCatalog.prices.quote({ priceId: tip.id, amount: '4.99' }))).toMatchObject({
      code: 'BAD_REQUEST',
      cause: 'pay.price_amount_below_minimum',
    });
    expect((await refusal(() => as(owner).merchantCatalog.prices.quote({ priceId: tip.id, amount: '100.01' }))).cause).toBe(
      'pay.price_amount_above_maximum',
    );
    expect((await as(owner).merchantCatalog.prices.quote({ priceId: tip.id, amount: '5' })).amount).toBe('5');
    expect((await as(owner).merchantCatalog.prices.quote({ priceId: tip.id, amount: '12.50' })).amount).toBe('12.5');
  });

  it('lets finance and viewers read and quote but not add or move the default, and refuses a session without a second factor', async () => {
    const productId = await product();
    const made = (await as(owner).merchantCatalog.prices.create(fixed(productId, '9'))).price;
    for (const who of [finance, viewer]) {
      expect(await listed(productId, who)).toHaveLength(1);
      expect((await refusal(() => as(who).merchantCatalog.prices.create(fixed(productId, '1')))).code).toBe('FORBIDDEN');
      expect((await refusal(() => as(who).merchantCatalog.prices.setDefault({ productId, priceId: made.id }))).code).toBe('FORBIDDEN');
    }
    expect((await refusal(() => as(owner, 100, { mfa: false }).merchantCatalog.prices.create(fixed(productId, '1')))).code).toBe(
      'FORBIDDEN',
    );
    expect((await refusal(() => as(owner, 100, { kid: 'key_TEST' }).merchantCatalog.prices.create(fixed(productId, '1')))).code).toBe(
      'FORBIDDEN',
    );
  });

  it("answers another business's product and price exactly as missing ones", async () => {
    const theirProduct = await product(otherOwner, 'TEST Their poster');
    const theirPrice = (await as(otherOwner).merchantCatalog.prices.create(fixed(theirProduct, '3'))).price;
    for (const call of [
      () => as(owner).merchantCatalog.prices.list({ productId: theirProduct, limit: 5 }),
      () => as(owner).merchantCatalog.prices.create(fixed(theirProduct, '1')),
      () => as(owner).merchantCatalog.prices.list({ productId: 'not-a-product', limit: 5 }),
    ]) {
      expect(await refusal(call)).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.product_not_found' });
    }
    expect(await refusal(() => as(owner).merchantCatalog.prices.quote({ priceId: theirPrice.id }))).toMatchObject({
      code: 'NOT_FOUND',
      cause: 'pay.price_not_found',
    });
    const mine = await product();
    expect(await refusal(() => as(owner).merchantCatalog.prices.setDefault({ productId: mine, priceId: theirPrice.id }))).toMatchObject({
      code: 'NOT_FOUND',
      cause: 'pay.price_not_found',
    });
  });

  it("pages a product's prices oldest first without skipping or repeating one", async () => {
    const productId = await product();
    for (const amount of ['1', '2', '3', '4', '5']) await as(owner).merchantCatalog.prices.create(fixed(productId, amount));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await as(owner).merchantCatalog.prices.list({ productId, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((p) => p.amount ?? ''));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['1', '2', '3', '4', '5']);
  });

  it('keeps a price as made: only its default mark and archiving change, and archiving is final', async () => {
    const productId = await product();
    const made = (await as(owner).merchantCatalog.prices.create(fixed(productId, '20'))).price;
    await expect(sql`UPDATE pay.catalog_prices SET amount = 19 WHERE id = ${made.id}`).rejects.toThrow(/never edited/);
    await expect(sql`UPDATE pay.catalog_prices SET status = 'archived' WHERE id = ${made.id}`).rejects.toThrow(
      /catalog_prices_default_active/,
    );
    await sql`UPDATE pay.catalog_prices SET is_default = false, status = 'archived' WHERE id = ${made.id}`;
    await expect(sql`UPDATE pay.catalog_prices SET status = 'active' WHERE id = ${made.id}`).rejects.toThrow(/never edited/);
    expect(await refusal(() => as(owner).merchantCatalog.prices.quote({ priceId: made.id }))).toMatchObject({
      cause: 'pay.price_archived',
    });
    expect(await refusal(() => as(owner).merchantCatalog.prices.setDefault({ productId, priceId: made.id }))).toMatchObject({
      cause: 'pay.price_archived',
    });
  });

  it('takes no new price, default move or quote on an archived product', async () => {
    const productId = await product();
    const first = (await as(owner).merchantCatalog.prices.create(fixed(productId, '20'))).price;
    const second = (await as(owner).merchantCatalog.prices.create(fixed(productId, '30'))).price;
    await sql`UPDATE pay.catalog_products SET status = 'archived', version = version + 1 WHERE id = ${productId}`;
    for (const call of [
      () => as(owner).merchantCatalog.prices.create(fixed(productId, '1')),
      () => as(owner).merchantCatalog.prices.setDefault({ productId, priceId: second.id }),
      () => as(owner).merchantCatalog.prices.quote({ priceId: first.id }),
    ]) {
      expect(await refusal(call)).toMatchObject({ code: 'PRECONDITION_FAILED', cause: 'pay.product_archived' });
    }
    // Its prices still read, so old documents that name them resolve.
    expect((await listed(productId)).map((p) => p.id)).toEqual([first.id, second.id]);
  });
});

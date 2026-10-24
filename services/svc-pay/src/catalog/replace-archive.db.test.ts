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
import { parseAmount } from '@intafaced/ledger-client';
import { SubscriptionService } from '../subscriptions/subscription-service.js';
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
    .withDatabase('intafaced_catalog_replace_test')
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

describe('replacing prices, archiving and deleting products (M-adv-payments-core-20, J-merchant-03 step 4)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  let subs!: SubscriptionService;
  const owner = nid();
  const otherOwner = nid();
  const finance = nid();
  let merchant = '';
  let otherMerchant = '';

  const as = (userId: string) =>
    createMerchantCatalogRouter({ sql, imageRule: { maxBytes: 100 } }).createCaller(ctxOf(principalOf(userId)));

  beforeAll(async () => {
    const opened = await openAdmin();
    adminStop = opened.stop;
    db = await createTestDatabase({ service: 'pay', url: opened.url, migrations });
    sql = db.sql;
    subs = new SubscriptionService(sql, () => new Date('2026-10-24T00:00:00.000Z'));
    merchant = (
      await sql<
        Array<{ id: string }>
      >`INSERT INTO pay.merchants (user_id, kyb_status, status) VALUES (${owner}, 'approved', 'active') RETURNING id`
    )[0]!.id;
    otherMerchant = (
      await sql<
        Array<{ id: string }>
      >`INSERT INTO pay.merchants (user_id, kyb_status, status) VALUES (${otherOwner}, 'approved', 'active') RETURNING id`
    )[0]!.id;
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchant}, ${finance}, 'finance', 'active', ${owner}, now())`;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  const product = async (who = owner, name = 'TEST Plan', imageId?: string) =>
    (await as(who).merchantCatalog.products.create({ requestId: nid(), name, type: 'service', ...(imageId ? { imageId } : {}) })).product
      .id;
  const fixed = (productId: string, amount: string, billing: 'one_time' | 'monthly' = 'monthly', assetId = 'USDC') => ({
    requestId: nid(),
    productId,
    billing,
    kind: 'fixed' as const,
    assetId,
    amount,
  });
  const price = async (productId: string, amount = '5', billing: 'one_time' | 'monthly' = 'monthly', who = owner) =>
    (await as(who).merchantCatalog.prices.create(fixed(productId, amount, billing))).price;
  const mandate = async (merchantId = merchant, amount = '5', cadence: 'monthly' | 'weekly' = 'monthly', assetId = 'USDC') =>
    (
      await subs.createMandate({
        merchantId,
        customerId: `TEST-customer-${nid()}`,
        assetId,
        amount: parseAmount(amount),
        cadence,
        startsAt: new Date('2026-11-01T00:00:00.000Z'),
      })
    ).id;
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const image = async () =>
    (
      await as(owner).merchantCatalog.images.upload({
        requestId: nid(),
        contentType: 'image/png',
        dataBase64: PNG.toString('base64'),
      })
    ).imageId;

  it('replaces a price in one step: the old is archived, the new takes its default mark and names it', async () => {
    const productId = await product();
    const old = await price(productId, '5');
    const other = await price(productId, '50', 'one_time');
    expect(old.isDefault).toBe(true);
    const input = { ...fixed(productId, '6'), priceId: old.id };
    const made = await as(owner).merchantCatalog.prices.replace(input);
    expect(made.replayed).toBe(false);
    expect(made.price).toMatchObject({ amount: '6', billing: 'monthly', isDefault: true, status: 'active', replacesId: old.id });
    expect(made.replaced).toMatchObject({ id: old.id, amount: '5', isDefault: false, status: 'archived', replacesId: null });
    const listed = (await as(owner).merchantCatalog.prices.list({ productId, limit: 50 })).items;
    expect(listed.map((p) => [p.id, p.status, p.isDefault])).toEqual([
      [old.id, 'archived', false],
      [other.id, 'active', false],
      [made.price.id, 'active', true],
    ]);

    // The same request again is the same pair; the same id with other details is refused.
    const again = await as(owner).merchantCatalog.prices.replace(input);
    expect(again).toMatchObject({ replayed: true, price: { id: made.price.id }, replaced: { id: old.id } });
    expect(await refusal(() => as(owner).merchantCatalog.prices.replace({ ...input, amount: '7' }))).toMatchObject({
      cause: 'pay.request_id_reused',
    });
    // A price is replaced once: the archived one is not replaced again, and a plain create cannot reuse the key.
    expect(await refusal(() => as(owner).merchantCatalog.prices.replace({ ...fixed(productId, '7'), priceId: old.id }))).toMatchObject({
      cause: 'pay.price_archived',
    });
    const { priceId: _old, ...plain } = input;
    expect(await refusal(() => as(owner).merchantCatalog.prices.create(plain))).toMatchObject({ cause: 'pay.request_id_reused' });

    // Replacing a price that is not the default leaves the default where it is.
    const second = await as(owner).merchantCatalog.prices.replace({ ...fixed(productId, '55', 'one_time'), priceId: other.id });
    expect(second.price.isDefault).toBe(false);
    expect(second.replaced.isDefault).toBe(false);
  });

  it('refuses a replacement on another product, another business, an archived product, or from finance', async () => {
    const productId = await product();
    const otherProduct = await product();
    const old = await price(productId);
    expect(await refusal(() => as(owner).merchantCatalog.prices.replace({ ...fixed(otherProduct, '6'), priceId: old.id }))).toMatchObject({
      cause: 'pay.price_not_found',
    });
    expect(await refusal(() => as(otherOwner).merchantCatalog.prices.replace({ ...fixed(productId, '6'), priceId: old.id }))).toMatchObject(
      {
        cause: 'pay.product_not_found',
      },
    );
    expect(await refusal(() => as(finance).merchantCatalog.prices.replace({ ...fixed(productId, '6'), priceId: old.id }))).toMatchObject({
      code: 'FORBIDDEN',
    });
    await as(owner).merchantCatalog.products.archive({ productId });
    expect(await refusal(() => as(owner).merchantCatalog.prices.replace({ ...fixed(productId, '6'), priceId: old.id }))).toMatchObject({
      cause: 'pay.product_archived',
    });
    expect((await as(owner).merchantCatalog.prices.get({ priceId: old.id })).price.status).toBe('active');
  });

  it('two replacements of one price at once make one new price', async () => {
    const productId = await product();
    const old = await price(productId);
    const results = await Promise.allSettled([
      as(owner).merchantCatalog.prices.replace({ ...fixed(productId, '6'), priceId: old.id }),
      as(owner).merchantCatalog.prices.replace({ ...fixed(productId, '7'), priceId: old.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as { cause?: { code?: string } }).cause?.code).toBe('pay.price_archived');
    const listed = (await as(owner).merchantCatalog.prices.list({ productId, limit: 50 })).items;
    expect(listed.filter((p) => p.status === 'active')).toHaveLength(1);
    expect(listed.filter((p) => p.isDefault)).toHaveLength(1);
  });

  it('a subscription started on a price stays on it through Replace price and archiving, and its price still reads', async () => {
    const productId = await product();
    const old = await price(productId, '5');
    const mandateId = await mandate();
    const sub = await subs.createSubscription({ mandateId, priceId: old.id });
    expect(sub.priceId).toBe(old.id);
    expect(await as(owner).merchantCatalog.prices.usage({ priceId: old.id })).toEqual({ priceId: old.id, openSubscriptions: 1 });
    expect(await as(finance).merchantCatalog.prices.usage({ priceId: old.id })).toEqual({ priceId: old.id, openSubscriptions: 1 });

    const made = await as(owner).merchantCatalog.prices.replace({ ...fixed(productId, '6'), priceId: old.id });
    expect((await subs.getSubscription(sub.id)).priceId).toBe(old.id);
    expect(await as(owner).merchantCatalog.prices.usage({ priceId: old.id })).toMatchObject({ openSubscriptions: 1 });
    expect(await as(owner).merchantCatalog.prices.usage({ priceId: made.price.id })).toMatchObject({ openSubscriptions: 0 });

    await as(owner).merchantCatalog.products.archive({ productId });
    const read = await as(owner).merchantCatalog.prices.get({ priceId: old.id });
    expect(read).toMatchObject({ price: { id: old.id, status: 'archived', amount: '5' }, product: { id: productId, status: 'archived' } });
    expect((await subs.getSubscription(sub.id)).priceId).toBe(old.id);

    // The database keeps a subscription on the price it started on, and a used price cannot be removed.
    await expect(sql`UPDATE pay.subscriptions SET price_id = ${made.price.id} WHERE id = ${sub.id}`).rejects.toThrow(/keeps the price/);
    await expect(sql`UPDATE pay.subscriptions SET price_id = NULL WHERE id = ${sub.id}`).rejects.toThrow(/keeps the price/);
    await expect(sql`DELETE FROM pay.catalog_prices WHERE id = ${old.id}`).rejects.toThrow(/foreign key/);
    // Cancelling it is still possible; the price stays recorded.
    const cancelled = await subs.cancelSubscription(sub.id);
    expect(cancelled.priceId).toBe(old.id);
    expect(await as(owner).merchantCatalog.prices.usage({ priceId: old.id })).toMatchObject({ openSubscriptions: 0 });
  });

  it('starts a subscription only on an active monthly fixed price of an active product with the mandate’s terms', async () => {
    const productId = await product();
    const monthly = await price(productId, '5');
    const once = await price(productId, '5', 'one_time');
    const code = async (priceId: string, mandateId: string) =>
      ((await subs.createSubscription({ mandateId, priceId }).catch((e: unknown) => e)) as { code?: string }).code;
    expect(await code(monthly.id, await mandate(merchant, '5.01'))).toBe('pay.subscription_price_terms_differ');
    expect(await code(monthly.id, await mandate(merchant, '5', 'weekly'))).toBe('pay.subscription_price_terms_differ');
    expect(await code(monthly.id, await mandate(merchant, '5', 'monthly', 'USDT'))).toBe('pay.subscription_price_terms_differ');
    expect(await code(once.id, await mandate())).toBe('pay.subscription_price_terms_differ');
    expect(await code(monthly.id, await mandate(otherMerchant))).toBe('pay.price_not_found');
    expect(await code(nid(), await mandate())).toBe('pay.price_not_found');
    // "5" and "5.000" are the same amount.
    const exact = await subs.createSubscription({ mandateId: await mandate(merchant, '5.000'), priceId: monthly.id });
    expect(exact.priceId).toBe(monthly.id);

    const replaced = await as(owner).merchantCatalog.prices.replace({ ...fixed(productId, '5'), priceId: monthly.id });
    expect(await code(monthly.id, await mandate())).toBe('pay.price_archived');
    await as(owner).merchantCatalog.products.archive({ productId });
    expect(await code(replaced.price.id, await mandate())).toBe('pay.product_archived');
    // Without a price a subscription starts as it always did.
    expect((await subs.createSubscription({ mandateId: await mandate() })).priceId).toBeNull();
  });

  it('binds the price into the create key: the same key with another price is refused', async () => {
    const productId = await product();
    const a = await price(productId, '5');
    const b = await price(productId, '5');
    const mandateId = await mandate();
    const first = await subs.createSubscription({ mandateId, priceId: a.id, idempotencyKey: `TEST-key-${mandateId}` });
    expect((await subs.createSubscription({ mandateId, priceId: a.id, idempotencyKey: `TEST-key-${mandateId}` })).id).toBe(first.id);
    await expect(subs.createSubscription({ mandateId, priceId: b.id, idempotencyKey: `TEST-key-${mandateId}` })).rejects.toMatchObject({
      code: 'pay.idempotency_conflict',
    });
    await expect(subs.createSubscription({ mandateId, idempotencyKey: `TEST-key-${mandateId}` })).rejects.toMatchObject({
      code: 'pay.idempotency_conflict',
    });
  });

  it('archives a product out of lists and pickers, reads it by id, and unarchives it', async () => {
    const productId = await product(owner, 'TEST Archived plan');
    const kept = await price(productId, '9');
    const choices = async () => (await as(owner).merchantCatalog.prices.choices({ billing: 'monthly', limit: 100 })).items;
    expect((await choices()).map((c) => c.price.id)).toContain(kept.id);
    expect((await choices()).find((c) => c.price.id === kept.id)?.product).toMatchObject({ name: 'TEST Archived plan', status: 'active' });

    const archived = await as(owner).merchantCatalog.products.archive({ productId });
    expect(archived).toMatchObject({ status: 'archived' });
    // Archiving twice changes nothing.
    expect((await as(owner).merchantCatalog.products.archive({ productId })).version).toBe(archived.version);
    const ids = async (status: 'active' | 'archived') =>
      (await as(owner).merchantCatalog.products.list({ status, limit: 100 })).items.map((p) => p.id);
    expect(await ids('active')).not.toContain(productId);
    expect(await ids('archived')).toContain(productId);
    expect((await as(finance).merchantCatalog.products.get({ productId })).status).toBe('archived');
    expect((await choices()).map((c) => c.price.id)).not.toContain(kept.id);
    expect(await refusal(() => as(owner).merchantCatalog.prices.create(fixed(productId, '1')))).toMatchObject({
      cause: 'pay.product_archived',
    });
    expect(await refusal(() => as(finance).merchantCatalog.products.archive({ productId }))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await refusal(() => as(otherOwner).merchantCatalog.products.unarchive({ productId }))).toMatchObject({
      cause: 'pay.product_not_found',
    });

    const back = await as(owner).merchantCatalog.products.unarchive({ productId });
    expect(back).toMatchObject({ status: 'active', version: archived.version + 1 });
    expect(await ids('active')).toContain(productId);
    expect((await choices()).map((c) => c.price.id)).toContain(kept.id);
  });

  it('offers only active prices of active products, narrowed by billing, kind and asset, paged', async () => {
    const productId = await product();
    const a = await price(productId, '1');
    const b = await price(productId, '2');
    const once = await price(productId, '3', 'one_time');
    const usdt = (await as(owner).merchantCatalog.prices.create(fixed(productId, '4', 'monthly', 'USDT'))).price;
    const replaced = await as(owner).merchantCatalog.prices.replace({ ...fixed(productId, '2.5'), priceId: b.id });
    const mine = (items: Array<{ price: { id: string } }>) =>
      items.map((c) => c.price.id).filter((id) => [a.id, b.id, once.id, usdt.id, replaced.price.id].includes(id));
    const monthlyUsdc = await as(owner).merchantCatalog.prices.choices({ billing: 'monthly', kind: 'fixed', assetId: 'USDC', limit: 100 });
    expect(mine(monthlyUsdc.items)).toEqual([replaced.price.id, a.id]);
    const atAmount = await as(owner).merchantCatalog.prices.choices({ billing: 'monthly', assetId: 'USDC', amount: '2.50', limit: 100 });
    expect(mine(atAmount.items)).toEqual([replaced.price.id]);
    const page1 = await as(owner).merchantCatalog.prices.choices({ limit: 1 });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await as(owner).merchantCatalog.prices.choices({ limit: 1, cursor: page1.nextCursor! });
    expect(page2.items[0]!.price.id).not.toBe(page1.items[0]!.price.id);
    expect((await as(otherOwner).merchantCatalog.prices.choices({ limit: 100 })).items).toEqual([]);
    expect(await refusal(() => as(otherOwner).merchantCatalog.prices.get({ priceId: a.id }))).toMatchObject({
      cause: 'pay.price_not_found',
    });
    expect(await refusal(() => as(otherOwner).merchantCatalog.prices.usage({ priceId: a.id }))).toMatchObject({
      cause: 'pay.price_not_found',
    });
  });

  it('deletes only a product with no price, with its image unless another product shows it', async () => {
    const priced = await product();
    await price(priced);
    expect(await refusal(() => as(owner).merchantCatalog.products.delete({ productId: priced }))).toMatchObject({
      cause: 'pay.product_has_prices',
    });
    await as(owner).merchantCatalog.products.archive({ productId: priced });
    expect(await refusal(() => as(owner).merchantCatalog.products.delete({ productId: priced }))).toMatchObject({
      cause: 'pay.product_has_prices',
    });

    const shared = await image();
    const one = await product(owner, 'TEST One', shared);
    const two = await product(owner, 'TEST Two', shared);
    expect(await refusal(() => as(finance).merchantCatalog.products.delete({ productId: one }))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await refusal(() => as(otherOwner).merchantCatalog.products.delete({ productId: one }))).toMatchObject({
      cause: 'pay.product_not_found',
    });
    expect(await as(owner).merchantCatalog.products.delete({ productId: one })).toEqual({ productId: one, deleted: true });
    expect(await refusal(() => as(owner).merchantCatalog.products.get({ productId: one }))).toMatchObject({
      cause: 'pay.product_not_found',
    });
    expect((await as(owner).merchantCatalog.images.get({ imageId: shared })).imageId).toBe(shared);
    await as(owner).merchantCatalog.products.delete({ productId: two });
    expect(await refusal(() => as(owner).merchantCatalog.images.get({ imageId: shared }))).toMatchObject({
      cause: 'pay.product_image_not_found',
    });
    expect(await refusal(() => as(owner).merchantCatalog.products.delete({ productId: two }))).toMatchObject({
      cause: 'pay.product_not_found',
    });
  });

  it('tells a retried create of a deleted product that it was deleted, instead of making it again', async () => {
    const create = { requestId: nid(), name: 'TEST Short-lived', type: 'digital' as const };
    const made = (await as(owner).merchantCatalog.products.create(create)).product;
    await as(owner).merchantCatalog.products.delete({ productId: made.id });
    expect(await refusal(() => as(owner).merchantCatalog.products.create(create))).toMatchObject({ cause: 'pay.product_deleted' });
    expect(await refusal(() => as(owner).merchantCatalog.products.create({ ...create, name: 'TEST Other' }))).toMatchObject({
      cause: 'pay.request_id_reused',
    });
    const [kept] = await sql<Array<{ product_id: string; deleted_by: string }>>`
      SELECT product_id, deleted_by FROM pay.catalog_product_tombstones WHERE request_id = ${create.requestId}::uuid`;
    expect(kept).toEqual({ product_id: made.id, deleted_by: owner });
    // A new create of the same name, with its own key, is a new product.
    expect((await as(owner).merchantCatalog.products.create({ ...create, requestId: nid() })).replayed).toBe(false);
  });

  it('a Replace price retried while the first is still running answers with the first, not a refusal', async () => {
    const productId = await product();
    const old = await price(productId);
    const input = { ...fixed(productId, '6'), priceId: old.id };
    const both = await Promise.all([as(owner).merchantCatalog.prices.replace(input), as(owner).merchantCatalog.prices.replace(input)]);
    expect(both[0].price.id).toBe(both[1].price.id);
    expect(both.map((r) => r.replayed).sort()).toEqual([false, true]);
  });

  it('a subscription started while its product is being archived waits for the archive and is refused', async () => {
    const productId = await product();
    const monthly = await price(productId, '5');
    const mandateId = await mandate();
    let started!: Promise<unknown>;
    await sql.begin(async (tx) => {
      // The archive holds the product's row; the subscription's check has to wait for it.
      await tx`UPDATE pay.catalog_products SET status = 'archived', version = version + 1 WHERE id = ${productId}::uuid`;
      started = subs.createSubscription({ mandateId, priceId: monthly.id }).catch((e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(await started).toMatchObject({ code: 'pay.product_archived' });
    const [count] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.subscriptions WHERE price_id = ${monthly.id}::uuid`;
    expect(count!.n).toBe(0);
  });
});

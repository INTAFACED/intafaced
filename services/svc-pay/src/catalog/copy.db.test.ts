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
    .withDatabase('intafaced_catalog_copy_test')
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

describe('the test catalogue and copying it to live and back (M-adv-payments-core-21, J-merchant-03 step 6)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = nid();
  const otherOwner = nid();
  const viewer = nid();
  let merchant = '';

  const as = (userId: string) =>
    createMerchantCatalogRouter({ sql, imageRule: { maxBytes: 100 } }).createCaller(ctxOf(principalOf(userId)));
  const copy = (from: 'live' | 'test', to: 'live' | 'test', who = owner) => as(who).merchantCatalog.copy({ from, to });
  const product = async (mode: 'live' | 'test', name: string, productKey?: string, who = owner) =>
    (
      await as(who).merchantCatalog.products.create({
        requestId: nid(),
        mode,
        name,
        type: 'service',
        unitLabel: 'hour',
        ...(productKey ? { productKey } : {}),
      })
    ).product;
  const names = async (mode: 'live' | 'test', who = owner) =>
    (await as(who).merchantCatalog.products.list({ mode, limit: 100 })).items.map((p) => p.name).sort();

  beforeAll(async () => {
    const opened = await openAdmin();
    adminStop = opened.stop;
    db = await createTestDatabase({ service: 'pay', url: opened.url, migrations });
    sql = db.sql;
    merchant = (
      await sql<
        Array<{ id: string }>
      >`INSERT INTO pay.merchants (user_id, kyb_status, status) VALUES (${owner}, 'approved', 'active') RETURNING id`
    )[0]!.id;
    await sql`INSERT INTO pay.merchants (user_id, kyb_status, status) VALUES (${otherOwner}, 'approved', 'active')`;
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchant}, ${viewer}, 'viewer', 'active', ${owner}, now())`;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  it('keeps the test catalogue apart from live: each list shows its own, and a product reads by id in either', async () => {
    const t = await product('test', 'TEST Apart');
    expect(t.mode).toBe('test');
    expect(await names('test')).toContain('TEST Apart');
    expect(await names('live')).not.toContain('TEST Apart');
    expect((await as(owner).merchantCatalog.products.get({ productId: t.id })).mode).toBe('test');
    // The same chosen id may be used once in each catalogue.
    await product('test', 'TEST Same id', 'same-id');
    await product('live', 'TEST Same id', 'same-id');
  });

  it('copies test products with their active prices to live, reports created and skipped, and a second copy makes nothing', async () => {
    const plan = await product('test', 'TEST Plan', 'plan');
    const old = (
      await as(owner).merchantCatalog.prices.create({
        requestId: nid(),
        productId: plan.id,
        billing: 'monthly',
        kind: 'fixed',
        assetId: 'USDC',
        amount: '5',
      })
    ).price;
    await as(owner).merchantCatalog.prices.replace({
      requestId: nid(),
      productId: plan.id,
      priceId: old.id,
      billing: 'monthly',
      kind: 'fixed',
      assetId: 'USDC',
      amount: '6',
    });
    await as(owner).merchantCatalog.prices.create({
      requestId: nid(),
      productId: plan.id,
      billing: 'one_time',
      kind: 'customer_chosen',
      assetId: 'USDT',
      minAmount: '1',
      maxAmount: '100',
    });
    const gone = await product('test', 'TEST Gone');
    await as(owner).merchantCatalog.products.archive({ productId: gone.id });

    const first = await copy('test', 'live');
    const made = first.created.find((c) => c.sourceId === plan.id)!;
    expect(made).toMatchObject({ productKey: 'plan', name: 'TEST Plan', prices: 2 });
    expect(first.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: gone.id, reason: 'archived', productId: null }),
        expect.objectContaining({ productKey: 'same-id', reason: 'id_taken' }),
      ]),
    );
    const live = await as(owner).merchantCatalog.products.get({ productId: made.productId });
    expect(live).toMatchObject({ mode: 'live', name: 'TEST Plan', type: 'service', unitLabel: 'hour', copiedFrom: plan.id });
    const terms = async (productId: string) =>
      (await as(owner).merchantCatalog.prices.list({ productId, limit: 100 })).items
        .filter((p) => p.status === 'active')
        .map((p) => [p.billing, p.kind, p.assetId, p.amount, p.minAmount, p.maxAmount, p.isDefault, p.status].join(' '))
        .sort();
    // Only the active prices go (the replaced 5 stays behind), with the same terms and default mark.
    expect(await terms(made.productId)).toEqual(await terms(plan.id));
    expect((await terms(made.productId)).join('|')).toContain('monthly fixed USDC 6');
    expect((await as(owner).merchantCatalog.prices.list({ productId: made.productId, limit: 100 })).items).toHaveLength(2);

    const liveBefore = await names('live');
    const second = await copy('test', 'live');
    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceId: plan.id, reason: 'copied_before', productId: made.productId })]),
    );
    expect(await names('live')).toEqual(liveBefore);

    // Copying live back to test does not bring the copy home again.
    const back = await copy('live', 'test');
    expect(back.created.find((c) => c.productId === plan.id || c.sourceId === made.productId)).toBeUndefined();
    expect(back.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceId: made.productId, reason: 'copied_before', productId: plan.id })]),
    );
  });

  it('a copy that was deleted is made again, and deleting it again still works', async () => {
    const draft = await product('test', 'TEST Draft copy');
    const once = (await copy('test', 'live')).created.find((c) => c.sourceId === draft.id)!;
    await as(owner).merchantCatalog.products.delete({ productId: once.productId });
    const twice = (await copy('test', 'live')).created.find((c) => c.sourceId === draft.id)!;
    expect(twice.productId).not.toBe(once.productId);
    await as(owner).merchantCatalog.products.delete({ productId: twice.productId });
    const thrice = (await copy('test', 'live')).created.find((c) => c.sourceId === draft.id)!;
    await as(owner).merchantCatalog.products.delete({ productId: thrice.productId });
    // Each deletion keeps its own record: no copy reused a deleted one's create key.
    const records = await sql`
      SELECT DISTINCT request_id FROM pay.catalog_product_tombstones
       WHERE product_id = ANY(${sql.array([once.productId, twice.productId, thrice.productId])}::uuid[])`;
    expect(records).toHaveLength(3);
  });

  it("a test product's price is quoted, while pickers offer live prices only", async () => {
    const t = await product('test', 'TEST Quoted in test');
    const price = (
      await as(owner).merchantCatalog.prices.create({
        requestId: nid(),
        productId: t.id,
        billing: 'one_time',
        kind: 'fixed',
        assetId: 'USDC',
        amount: '7',
      })
    ).price;
    expect(await as(owner).merchantCatalog.prices.quote({ priceId: price.id })).toMatchObject({ priceId: price.id, amount: '7' });
    const offered = (await as(owner).merchantCatalog.prices.choices({ limit: 100 })).items.map((p) => p.price.id);
    expect(offered).not.toContain(price.id);
  });

  it('two copies at once make each product once', async () => {
    const twin = await product('test', 'TEST Twin copy');
    const reports = await Promise.all([1, 2, 3, 4].map(() => copy('test', 'live')));
    const made = reports.flatMap((r) => r.created).filter((c) => c.sourceId === twin.id);
    expect(made).toHaveLength(1);
    expect((await names('live')).filter((n) => n === 'TEST Twin copy')).toHaveLength(1);
  });

  it('keeps each business to its own catalogue, and refuses viewers and a copy onto itself', async () => {
    await product('test', 'TEST Theirs', undefined, otherOwner);
    const report = await copy('test', 'live');
    expect([...report.created, ...report.skipped].map((r) => r.name)).not.toContain('TEST Theirs');
    expect(await refusal(() => copy('test', 'live', viewer))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await refusal(() => as(owner).merchantCatalog.copy({ from: 'live', to: 'live' }))).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a copy keeps its source for life', async () => {
    const src = await product('test', 'TEST Kept source');
    const made = (await copy('test', 'live')).created.find((c) => c.sourceId === src.id)!;
    const err = await sql`UPDATE pay.catalog_products SET copied_from = NULL, version = version + 1 WHERE id = ${made.productId}`.catch(
      (e: { code?: string }) => e,
    );
    expect((err as { code?: string }).code).toBe('23001');
  });

  it('imports a file into the test catalogue on its own key', async () => {
    const csv = 'name,type\nTEST Imported to test,digital\n';
    const toTest = await as(owner).merchantCatalog.products.import({ csv, commit: true, mode: 'test' });
    expect(toTest.products.map((p) => p.mode)).toEqual(['test']);
    const toLive = await as(owner).merchantCatalog.products.import({ csv, commit: true });
    expect(toLive.replayed).toBe(false);
    expect(toLive.products.map((p) => p.mode)).toEqual(['live']);
  });
});

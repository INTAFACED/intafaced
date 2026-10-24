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
    .withDatabase('intafaced_catalog_availability_test')
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

describe('stores and where each product is sold (M-adv-org-access-05, M-adv-payments-core-21, J-merchant-03 step 6)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = nid();
  const otherOwner = nid();
  const viewer = nid();
  let merchant = '';

  const as = (userId: string, over: Partial<Principal> = {}) =>
    createMerchantCatalogRouter({ sql, imageRule: { maxBytes: 100 } }).createCaller(ctxOf(principalOf(userId, over)));
  const store = async (name: string, who = owner) =>
    (await as(who).merchantStores.create({ requestId: nid(), name, timezone: 'Europe/Berlin' })).store;
  const priced = async (name: string) => {
    const product = (await as(owner).merchantCatalog.products.create({ requestId: nid(), name, type: 'physical' })).product;
    const price = (
      await as(owner).merchantCatalog.prices.create({
        requestId: nid(),
        productId: product.id,
        billing: 'one_time',
        kind: 'fixed',
        assetId: 'USDC',
        amount: '12',
      })
    ).price;
    return { product, price };
  };

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

  it('adds stores once per request, refuses a name already used in any case, and archives instead of deleting', async () => {
    const requestId = nid();
    const input = { requestId, name: 'TEST Market stall', address: 'TEST 1 Square', timezone: 'Europe/Berlin' };
    const made = await as(owner).merchantStores.create(input);
    expect(made).toMatchObject({ replayed: false, store: { name: 'TEST Market stall', timezone: 'Europe/Berlin', status: 'active' } });
    expect(await as(owner).merchantStores.create(input)).toEqual({ store: made.store, replayed: true });
    expect((await refusal(() => as(owner).merchantStores.create({ ...input, timezone: 'Europe/Paris' }))).cause).toBe(
      'pay.request_id_reused',
    );
    expect((await refusal(() => store('test market STALL'))).cause).toBe('pay.store_name_taken');
    expect(
      await refusal(() => as(owner).merchantStores.create({ requestId: nid(), name: 'TEST Nowhere', timezone: 'Mars/Base' })),
    ).toMatchObject({
      code: 'BAD_REQUEST',
    });
    // Another business may use the same name.
    await store('TEST Market stall', otherOwner);

    const archived = await as(owner).merchantStores.archive({ storeId: made.store.id });
    expect(archived).toMatchObject({ status: 'archived', version: 2 });
    expect(await as(owner).merchantStores.archive({ storeId: made.store.id })).toEqual(archived);
    expect((await as(viewer).merchantStores.list({ status: 'archived', limit: 10 })).items.map((s) => s.id)).toEqual([made.store.id]);
    await as(owner).merchantStores.reopen({ storeId: made.store.id });
    const err = await sql`DELETE FROM pay.stores WHERE id = ${made.store.id}`.catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('23001');
  });

  it('keeps stores to their business, and refuses viewers and a session without a second factor', async () => {
    const theirs = await store('TEST Theirs', otherOwner);
    expect((await as(owner).merchantStores.list({ limit: 100 })).items.map((s) => s.name)).not.toContain('TEST Theirs');
    expect((await refusal(() => as(owner).merchantStores.archive({ storeId: theirs.id }))).cause).toBe('pay.store_not_found');
    expect(await refusal(() => store('TEST By a viewer', viewer))).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await refusal(() => as(owner, { mfa: false }).merchantStores.create({ requestId: nid(), name: 'TEST No factor', timezone: 'UTC' })),
    ).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a product is sold everywhere until a store and channel is turned off, and a price check there refuses', async () => {
    const stall = await store('TEST Stall for checks');
    const shop = await store('TEST Shop for checks');
    const { product, price } = await priced('TEST Checked mug');
    const everywhere = await as(viewer).merchantCatalog.availability.get({ productId: product.id });
    expect(everywhere.stores.find((s) => s.storeId === stall.id)?.channels).toEqual({ online: true, in_person: true, invoice: true });

    const off = await as(owner).merchantCatalog.availability.set({
      productId: product.id,
      storeId: stall.id,
      channel: 'in_person',
      sold: false,
    });
    expect(off.stores.find((s) => s.storeId === stall.id)?.channels).toEqual({ online: true, in_person: false, invoice: true });
    expect(off.stores.find((s) => s.storeId === shop.id)?.channels.in_person).toBe(true);
    // Turning it off again changes nothing.
    expect(
      await as(owner).merchantCatalog.availability.set({ productId: product.id, storeId: stall.id, channel: 'in_person', sold: false }),
    ).toEqual(off);

    const quote = (storeId?: string, channel?: 'online' | 'in_person' | 'invoice') =>
      as(viewer).merchantCatalog.prices.quote({ priceId: price.id, ...(storeId && channel ? { storeId, channel } : {}) });
    expect((await refusal(() => quote(stall.id, 'in_person'))).cause).toBe('pay.product_not_sold_here');
    expect(await quote(stall.id, 'online')).toMatchObject({ amount: '12', assetId: 'USDC' });
    expect(await quote(shop.id, 'in_person')).toMatchObject({ amount: '12' });
    expect(await quote()).toMatchObject({ amount: '12' });

    await as(owner).merchantCatalog.availability.set({ productId: product.id, storeId: stall.id, channel: 'in_person', sold: true });
    expect(await quote(stall.id, 'in_person')).toMatchObject({ amount: '12' });
  });

  it("an archived store refuses a sale and a change, and keeps what it had; another business's store is not found", async () => {
    const closing = await store('TEST Closing store');
    const theirs = await store('TEST Their checks', otherOwner);
    const { product, price } = await priced('TEST Closing mug');
    await as(owner).merchantCatalog.availability.set({ productId: product.id, storeId: closing.id, channel: 'invoice', sold: false });
    await as(owner).merchantStores.archive({ storeId: closing.id });
    const set = (storeId: string) =>
      as(owner).merchantCatalog.availability.set({ productId: product.id, storeId, channel: 'online', sold: false });
    expect((await refusal(() => set(closing.id))).cause).toBe('pay.store_archived');
    expect(
      (await refusal(() => as(owner).merchantCatalog.prices.quote({ priceId: price.id, storeId: closing.id, channel: 'online' }))).cause,
    ).toBe('pay.store_archived');
    const kept = (await as(owner).merchantCatalog.availability.get({ productId: product.id })).stores.find((s) => s.storeId === closing.id);
    expect(kept).toMatchObject({ status: 'archived', channels: { online: true, in_person: true, invoice: false } });
    expect((await refusal(() => set(theirs.id))).cause).toBe('pay.store_not_found');
    expect(
      (await refusal(() => as(owner).merchantCatalog.prices.quote({ priceId: price.id, storeId: theirs.id, channel: 'online' }))).cause,
    ).toBe('pay.store_not_found');
    expect((await as(owner).merchantCatalog.availability.get({ productId: product.id })).stores.map((s) => s.storeId)).not.toContain(
      theirs.id,
    );
    expect(
      await refusal(() =>
        as(viewer).merchantCatalog.availability.set({ productId: product.id, storeId: closing.id, channel: 'online', sold: true }),
      ),
    ).toMatchObject({
      code: 'FORBIDDEN',
    });
    // A store and a channel go together.
    expect(await refusal(() => as(owner).merchantCatalog.prices.quote({ priceId: price.id, storeId: closing.id }))).toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('keeps a time zone in its canonical spelling, and refuses a bare offset', async () => {
    const made = (await as(owner).merchantStores.create({ requestId: nid(), name: 'TEST Lower zone', timezone: 'europe/berlin' })).store;
    expect(made.timezone).toBe('Europe/Berlin');
    expect(
      await refusal(() => as(owner).merchantStores.create({ requestId: nid(), name: 'TEST Offset zone', timezone: '+05:30' })),
    ).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a copy between test and live is not sold where its source is not', async () => {
    const kiosk = await store('TEST Kiosk');
    const source = (
      await as(owner).merchantCatalog.products.create({ requestId: nid(), mode: 'test', name: 'TEST Kiosk only', type: 'digital' })
    ).product;
    await as(owner).merchantCatalog.availability.set({ productId: source.id, storeId: kiosk.id, channel: 'in_person', sold: false });
    const made = (await as(owner).merchantCatalog.copy({ from: 'test', to: 'live' })).created.find((c) => c.sourceId === source.id)!;
    const copy = (await as(owner).merchantCatalog.availability.get({ productId: made.productId })).stores.find(
      (s) => s.storeId === kiosk.id,
    );
    expect(copy?.channels).toEqual({ online: true, in_person: false, invoice: true });
  });

  it('turning a product off waits for an archive of its store under way, then refuses', async () => {
    const busy = await store('TEST Busy store');
    const product = (await as(owner).merchantCatalog.products.create({ requestId: nid(), name: 'TEST Busy mug', type: 'physical' }))
      .product;
    // Hold the store's row the way an archive does, then let the archive commit while the change waits.
    const archiving = sql.begin(async (tx) => {
      await tx`UPDATE pay.stores SET status = 'archived', version = version + 1 WHERE id = ${busy.id}`;
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const change = refusal(() =>
      as(owner).merchantCatalog.availability.set({ productId: product.id, storeId: busy.id, channel: 'online', sold: false }),
    );
    await archiving;
    expect((await change).cause).toBe('pay.store_archived');
    expect(await sql`SELECT 1 FROM pay.catalog_product_unavailable WHERE product_id = ${product.id}`).toHaveLength(0);
  });

  it('deleting a product forgets where it was not sold', async () => {
    const corner = await store('TEST Corner');
    const product = (await as(owner).merchantCatalog.products.create({ requestId: nid(), name: 'TEST Short-lived', type: 'digital' }))
      .product;
    await as(owner).merchantCatalog.availability.set({ productId: product.id, storeId: corner.id, channel: 'online', sold: false });
    await as(owner).merchantCatalog.products.delete({ productId: product.id });
    expect(await sql`SELECT 1 FROM pay.catalog_product_unavailable WHERE product_id = ${product.id}`).toHaveLength(0);
    expect((await refusal(() => as(owner).merchantCatalog.availability.get({ productId: product.id }))).cause).toBe(
      'pay.product_not_found',
    );
  });
});

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
import { ProductCatalog } from './products.js';

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
    .withDatabase('intafaced_catalog_test')
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

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(58, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 3)]);

describe('product catalogue (M-catalogue-01, J-merchant-03 steps 1 and 2)', () => {
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

  it('starts empty, and refuses a list with no page size rather than guessing one', async () => {
    expect(await as(viewer).merchantCatalog.products.list({ limit: 20 })).toEqual({ items: [], nextCursor: null });
    expect(await refusal(() => as(owner).merchantCatalog.products.list({}))).toMatchObject({ cause: 'pay.merchant_ops_list_limit_unset' });
  });

  it('adds a product with a chosen id, and refuses that id again as taken', async () => {
    const made = await as(owner).merchantCatalog.products.create({
      requestId: nid(),
      productKey: 'tee-classic',
      name: 'TEST Classic tee',
      type: 'physical',
      unitLabel: 'shirt',
      statementDescriptor: 'TEST TEE SHOP',
    });
    expect(made.replayed).toBe(false);
    expect(made.product).toMatchObject({
      productKey: 'tee-classic',
      mode: 'live',
      name: 'TEST Classic tee',
      type: 'physical',
      unitLabel: 'shirt',
      statementDescriptor: 'TEST TEE SHOP',
      event: null,
      imageId: null,
      status: 'active',
      version: 1,
      createdBy: owner,
    });
    const taken = await refusal(() =>
      as(developer).merchantCatalog.products.create({ requestId: nid(), productKey: 'tee-classic', name: 'TEST Other', type: 'digital' }),
    );
    expect(taken).toMatchObject({ code: 'CONFLICT', cause: 'pay.product_id_taken' });
    // Another business may use the same id: ids are unique within one business.
    const elsewhere = await as(otherOwner).merchantCatalog.products.create({
      requestId: nid(),
      productKey: 'tee-classic',
      name: 'TEST Their tee',
      type: 'physical',
    });
    expect(elsewhere.product.productKey).toBe('tee-classic');
  });

  it('names a product svc-pay ids when none is chosen', async () => {
    const made = await as(admin).merchantCatalog.products.create({ requestId: nid(), name: 'TEST Ebook', type: 'digital' });
    expect(made.product.productKey).toMatch(/^prod_[a-z2-7]{16}$/);
    expect(made.product.createdBy).toBe(admin);
  });

  it('answers a retried create with the product it made, and refuses the same request id with other details', async () => {
    const requestId = nid();
    const body = { requestId, name: 'TEST Consultation', type: 'service' as const, unitLabel: 'hour' };
    const first = await as(owner).merchantCatalog.products.create(body);
    const again = await as(owner).merchantCatalog.products.create(body);
    expect(again).toEqual({ product: first.product, replayed: true });
    const reused = await refusal(() => as(owner).merchantCatalog.products.create({ ...body, name: 'TEST Something else' }));
    expect(reused).toMatchObject({ code: 'CONFLICT', cause: 'pay.request_id_reused' });
  });

  it('makes one product when the same create races itself', async () => {
    const body = { requestId: nid(), name: 'TEST Raced', type: 'digital' as const };
    const results = await Promise.all([1, 2, 3, 4].map(() => as(owner).merchantCatalog.products.create(body)));
    expect(new Set(results.map((r) => r.product.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const rows = await sql`SELECT id FROM pay.catalog_products WHERE request_id = ${body.requestId}::uuid`;
    expect(rows).toHaveLength(1);
  });

  it('asks an event for its start time and place, and refuses them on any other type', async () => {
    const event = { startsAt: '2026-12-01T18:00:00Z', location: 'TEST Hall, Berlin' };
    const made = await as(owner).merchantCatalog.products.create({ requestId: nid(), name: 'TEST Workshop', type: 'event', event });
    expect(made.product.event).toEqual({ startsAt: '2026-12-01T18:00:00.000Z', location: 'TEST Hall, Berlin' });
    expect(
      await refusal(() => as(owner).merchantCatalog.products.create({ requestId: nid(), name: 'TEST Gig', type: 'event' })),
    ).toMatchObject({
      cause: 'pay.product_event_details_required',
    });
    expect(
      await refusal(() => as(owner).merchantCatalog.products.create({ requestId: nid(), name: 'TEST Download', type: 'digital', event })),
    ).toMatchObject({ cause: 'pay.product_event_details_not_event' });
  });

  it('refuses a blank name, a malformed id and a descriptor outside the card rule before anything is written', async () => {
    const before = await sql`SELECT count(*)::int AS n FROM pay.catalog_products`;
    const bad = [
      { requestId: nid(), name: '   ', type: 'digital' },
      { requestId: nid(), name: 'TEST x', type: 'digital', productKey: 'Has Spaces' },
      { requestId: nid(), name: 'TEST x', type: 'digital', statementDescriptor: '1234' },
      { requestId: nid(), name: 'TEST x', type: 'digital', statementDescriptor: 'TEST "SHOP"' },
    ];
    for (const body of bad) {
      expect(await refusal(() => as(owner).merchantCatalog.products.create(body as never))).toMatchObject({ code: 'BAD_REQUEST' });
    }
    const after = await sql`SELECT count(*)::int AS n FROM pay.catalog_products`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('lets finance and viewers read but not add, and refuses an API key or a session without a second factor', async () => {
    for (const reader of [finance, viewer]) {
      const listed = await as(reader).merchantCatalog.products.list({ limit: 50 });
      expect(listed.items.length).toBeGreaterThan(0);
      expect(
        await refusal(() =>
          as(reader, 100, { scopes: ['pay:onboard'] }).merchantCatalog.products.create({
            requestId: nid(),
            name: 'TEST No',
            type: 'digital',
          }),
        ),
      ).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.team_role_forbidden' });
    }
    const catalog = new ProductCatalog(sql, { maxBytes: 100 });
    const viaKey = { merchantId: merchant, userId: owner, role: 'owner' as const, viaApiKey: true, interactive: false };
    expect(await refusal(() => catalog.create(viaKey, { requestId: nid(), name: 'TEST Key', type: 'digital' }))).toMatchObject({
      code: 'pay.catalog_interactive_only',
    });
    for (const over of [{ kid: 'ifc_test_key' }, { mfa: false }] as const) {
      expect(
        await refusal(() =>
          as(owner, 100, over).merchantCatalog.products.create({ requestId: nid(), name: 'TEST No factor', type: 'digital' }),
        ),
      ).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it("answers another business's product exactly as a missing one, and lists only the caller's", async () => {
    const theirs = await as(otherOwner).merchantCatalog.products.list({ limit: 50 });
    expect(theirs.items.map((p) => p.name)).toEqual(['TEST Their tee']);
    const theirId = theirs.items[0]!.id;
    expect(await refusal(() => as(owner).merchantCatalog.products.get({ productId: theirId }))).toMatchObject({
      code: 'NOT_FOUND',
      cause: 'pay.product_not_found',
    });
    expect(await refusal(() => as(owner).merchantCatalog.products.get({ productId: nid() }))).toMatchObject({
      code: 'NOT_FOUND',
      cause: 'pay.product_not_found',
    });
    const mine = await as(owner).merchantCatalog.products.list({ limit: 50 });
    expect(mine.items.every((p) => p.name !== 'TEST Their tee')).toBe(true);
  });

  it('pages newest first without skipping or repeating a product', async () => {
    const all = await as(owner).merchantCatalog.products.list({ limit: 100 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await as(owner).merchantCatalog.products.list({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.items.map((p) => p.id));
  });

  it('refuses every image while no size is published, and says the rule when one is', async () => {
    const upload = { requestId: nid(), contentType: 'image/png', dataBase64: PNG.toString('base64') };
    expect(await as(owner, null).merchantCatalog.images.rules({})).toEqual({
      maxBytes: null,
      types: ['image/png', 'image/jpeg', 'image/webp'],
    });
    expect(await refusal(() => as(owner, null).merchantCatalog.images.upload(upload))).toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: 'pay.product_image_rules_unset',
    });
    expect(await as(viewer).merchantCatalog.images.rules({})).toEqual({ maxBytes: 100, types: ['image/png', 'image/jpeg', 'image/webp'] });
  });

  it('refuses an image over the size, a GIF, and bytes that are not the type named, and keeps none of them', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(200, 1)]);
    const cases: Array<[string, Buffer, string]> = [
      ['image/png', big, 'pay.product_image_too_large'],
      ['image/gif', GIF, 'pay.product_image_type_refused'],
      ['image/png', GIF, 'pay.product_image_type_refused'],
      ['image/png', JPEG, 'pay.product_image_type_refused'],
    ];
    for (const [contentType, bytes, code] of cases) {
      expect(
        await refusal(() =>
          as(owner).merchantCatalog.images.upload({ requestId: nid(), contentType, dataBase64: bytes.toString('base64') }),
        ),
      ).toMatchObject({ code: 'BAD_REQUEST', cause: code });
    }
    expect(
      await refusal(() => as(owner).merchantCatalog.images.upload({ requestId: nid(), contentType: 'image/png', dataBase64: '@@@@' })),
    ).toMatchObject({
      cause: 'pay.product_image_unreadable',
    });
    const kept = await sql`SELECT count(*)::int AS n FROM pay.catalog_product_images`;
    expect(kept[0]!.n).toBe(0);
  });

  it('keeps a PNG once, puts it on a product, and shows it only to that business', async () => {
    const requestId = nid();
    const upload = { requestId, contentType: 'image/png', dataBase64: PNG.toString('base64') };
    const image = await as(developer).merchantCatalog.images.upload(upload);
    expect(image).toMatchObject({ contentType: 'image/png', byteSize: PNG.length });
    expect(await as(developer).merchantCatalog.images.upload(upload)).toEqual(image);
    expect(
      await refusal(() =>
        as(developer).merchantCatalog.images.upload({ ...upload, contentType: 'image/jpeg', dataBase64: JPEG.toString('base64') }),
      ),
    ).toMatchObject({ cause: 'pay.request_id_reused' });
    const made = await as(owner).merchantCatalog.products.create({
      requestId: nid(),
      name: 'TEST Poster',
      type: 'physical',
      imageId: image.imageId,
    });
    expect(made.product.imageId).toBe(image.imageId);
    const file = await as(viewer).merchantCatalog.images.get({ imageId: image.imageId });
    expect(Buffer.from(file.dataBase64, 'base64').equals(PNG)).toBe(true);
    expect(await refusal(() => as(otherOwner).merchantCatalog.images.get({ imageId: image.imageId }))).toMatchObject({
      cause: 'pay.product_image_not_found',
    });
    expect(
      await refusal(() =>
        as(otherOwner).merchantCatalog.products.create({ requestId: nid(), name: 'TEST Stolen', type: 'physical', imageId: image.imageId }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.product_image_not_found' });
  });

  it('keeps an image as uploaded and a product keeps its key, business and maker', async () => {
    const [row] = await sql<Array<{ id: string }>>`SELECT id FROM pay.catalog_products WHERE merchant_id = ${merchant} LIMIT 1`;
    await expect(
      sql`UPDATE pay.catalog_products SET product_key = 'renamed-key', version = version + 1 WHERE id = ${row!.id}`,
    ).rejects.toThrow(/keeps its business, mode, key and maker/);
    await expect(sql`UPDATE pay.catalog_products SET name = 'TEST Renamed' WHERE id = ${row!.id}`).rejects.toThrow(/raises its version/);
    await expect(sql`UPDATE pay.catalog_product_images SET content_type = 'image/jpeg'`).rejects.toThrow(/kept as uploaded/);
  });

  it('refuses every procedure without a database', async () => {
    const none = createMerchantCatalogRouter(undefined).createCaller(ctxOf(principalOf(owner)));
    expect(await refusal(() => none.merchantCatalog.products.list({ limit: 1 }))).toMatchObject({ cause: 'pay.merchant_ops_unavailable' });
  });
});

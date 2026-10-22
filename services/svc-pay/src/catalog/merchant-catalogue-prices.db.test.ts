import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLedger } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import type { MerchantCaller, MerchantRole } from '../merchant-ops/roles.js';
import { CatalogProductService } from './product-service.js';
import { CatalogPriceService } from './price-service.js';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createMerchantOpsRouter, type MerchantOpsDeps } from '../merchant-ops/router.js';

/** M-catalogue-02 prices, default price and quote against a real Postgres. */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const c = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_catalog_test')
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

describe('M-catalogue-02 prices (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let products!: CatalogProductService;
  let prices!: CatalogPriceService;
  let pay!: PayService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
    products = new CatalogProductService(sql);
    prices = new CatalogPriceService(sql, { PAY_CATALOG_QUOTE_QUANTITY_MAX: '1000', PAY_CATALOG_ASSET_DECIMALS: 'USDC:18,USD:2' });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  async function setup(role: MerchantRole = 'owner') {
    const userId = randomUUID();
    const m = await pay.createMerchant({ userId, pricing: { feeBps: 0 } });
    const c: MerchantCaller = { merchantId: m.id, userId, role, viaApiKey: false, interactive: true };
    const owner: MerchantCaller = { ...c, role: 'owner' };
    const p = await products.create(owner, { requestId: randomUUID(), name: 'Seats', type: 'service' });
    return { c, owner, productId: p.id };
  }
  const seat = { assetId: 'USDC', model: 'per_seat' as const, unitAmount: '12.5', taxBehavior: 'exclusive' as const };

  it('create retried with the same requestId returns the first price; a different body is refused', async () => {
    const { owner, productId } = await setup();
    const requestId = randomUUID();
    const a = await prices.create(owner, { ...seat, productId, requestId });
    expect(await prices.create(owner, { ...seat, productId, requestId })).toEqual(a);
    expect(await codeOf(prices.create(owner, { ...seat, unitAmount: '13', productId, requestId }))).toBe('pay.request_id_reused');
    expect(await prices.list(owner, { productId })).toHaveLength(1);
  });

  it('amount, asset, interval and model cannot change after create, even in SQL', async () => {
    const { owner, productId } = await setup();
    const p = await prices.create(owner, { ...seat, productId, requestId: randomUUID(), recurring: { unit: 'month', count: 1 } });
    expect(p.recurring).toEqual({ unit: 'month', count: 1 });
    await expect(sql`UPDATE pay.catalog_prices SET unit_amount = 1 WHERE id = ${p.id}`).rejects.toThrow(/catalog.price_immutable/);
    await sql`UPDATE pay.catalog_prices SET description = 'ok' WHERE id = ${p.id}`;
  });

  it('default price: last write wins, repeat is a no-op, archiving the default clears it', async () => {
    const { owner, productId } = await setup();
    const a = await prices.create(owner, { ...seat, productId, requestId: randomUUID() });
    const b = await prices.create(owner, { ...seat, unitAmount: '10', productId, requestId: randomUUID() });
    expect((await prices.setDefault(owner, { requestId: randomUUID(), priceId: a.id })).isDefault).toBe(true);
    expect((await prices.setDefault(owner, { requestId: randomUUID(), priceId: b.id })).isDefault).toBe(true);
    expect((await prices.get(owner, a.id)).isDefault).toBe(false);
    expect((await prices.setDefault(owner, { requestId: randomUUID(), priceId: b.id })).isDefault).toBe(true);
    const archived = await prices.archive(owner, { requestId: randomUUID(), priceId: b.id });
    expect(archived).toMatchObject({ archived: true, isDefault: false });
    expect(await codeOf(prices.setDefault(owner, { requestId: randomUUID(), priceId: b.id }))).toBe('pay.catalog_price_archived');
    expect(await prices.list(owner, { productId })).toHaveLength(1);
    expect(await prices.list(owner, { productId, includeArchived: true })).toHaveLength(2);
  });

  it('quote is exact and bounded by the owner ceiling; unset ceiling refuses', async () => {
    const { c, owner, productId } = await setup('viewer');
    const g = await prices.create(owner, {
      productId,
      requestId: randomUUID(),
      assetId: 'USDC',
      model: 'graduated',
      tiers: [
        { upTo: 10, unitAmount: '1.5' },
        { upTo: null, unitAmount: '0.000000000000000001' },
      ],
      taxBehavior: 'unspecified',
    });
    expect((await prices.quote(c, { priceId: g.id, quantity: 12 })).total).toBe('15.000000000000000002');
    expect(await codeOf(prices.quote(c, { priceId: g.id, quantity: 1001 }))).toBe('pay.catalog_quote_quantity_invalid');
    const unset = new CatalogPriceService(sql, { PAY_CATALOG_ASSET_DECIMALS: 'USDC:18' });
    expect(await codeOf(unset.quote(c, { priceId: g.id, quantity: 1 }))).toBe('pay.catalog_quote_quantity_max_unset');
  });

  it('refuses usage pricing, bad tiers, archived products, viewers writing and other merchants reading', async () => {
    const { c, owner, productId } = await setup('viewer');
    const r = { productId, requestId: randomUUID() };
    expect(await codeOf(prices.create(owner, { ...seat, ...r, model: 'usage' }))).toBe('pay.catalog_usage_source_unset');
    expect(
      await codeOf(
        prices.create(owner, { ...r, assetId: 'USDC', model: 'volume', tiers: [{ upTo: 5, unitAmount: '1' }], taxBehavior: 'inclusive' }),
      ),
    ).toBe('pay.catalog_price_tiers_invalid');
    expect(await codeOf(prices.create(c, { ...seat, ...r }))).toBe('pay.team_role_forbidden');
    const p = await prices.create(owner, { ...seat, productId, requestId: randomUUID() });
    const other = await setup();
    expect(await codeOf(prices.get(other.owner, p.id))).toBe('pay.catalog_price_not_found');
    await products.archive(owner, { requestId: randomUUID(), productId });
    expect(await codeOf(prices.create(owner, { ...seat, productId, requestId: randomUUID() }))).toBe('pay.catalog_product_archived');
  });
  it('refuses amounts with more decimals than the asset allows, unknown assets, and an unset scale table', async () => {
    const { owner, productId } = await setup();
    const usd = { ...seat, assetId: 'USD', productId };
    expect(await codeOf(prices.create(owner, { ...usd, unitAmount: '1.005', requestId: randomUUID() }))).toBe(
      'pay.catalog_price_amount_scale',
    );
    expect((await prices.create(owner, { ...usd, unitAmount: '1.05', requestId: randomUUID() })).unitAmount).toBe('1.05');
    expect(
      await codeOf(
        prices.create(owner, {
          productId,
          requestId: randomUUID(),
          assetId: 'USD',
          model: 'volume',
          tiers: [
            { upTo: 5, unitAmount: '1' },
            { upTo: null, unitAmount: '0.999' },
          ],
          taxBehavior: 'inclusive',
        }),
      ),
    ).toBe('pay.catalog_price_amount_scale');
    expect(await codeOf(prices.create(owner, { ...seat, assetId: 'FOO', productId, requestId: randomUUID() }))).toBe(
      'pay.catalog_price_asset_unknown',
    );
    const noScale = new CatalogPriceService(sql, { PAY_CATALOG_QUOTE_QUANTITY_MAX: '10' });
    expect(await codeOf(noScale.create(owner, { ...seat, productId, requestId: randomUUID() }))).toBe('pay.catalog_asset_scale_unset');
  });

  it('concurrent create / setDefault / archive with the same requestId replay one result, never a 500', async () => {
    const { owner, productId } = await setup();
    const requestId = randomUUID();
    const made = await Promise.all([1, 2, 3].map(() => prices.create(owner, { ...seat, productId, requestId })));
    expect(new Set(made.map((p) => p.id)).size).toBe(1);
    const priceId = made[0]!.id;
    const d = randomUUID();
    const defs = await Promise.all([1, 2, 3].map(() => prices.setDefault(owner, { requestId: d, priceId })));
    expect(defs.every((p) => p.isDefault)).toBe(true);
    const a = randomUUID();
    const arch = await Promise.all([1, 2, 3].map(() => prices.archive(owner, { requestId: a, priceId })));
    expect(arch.every((p) => p.archived)).toBe(true);
    expect(await prices.list(owner, { productId, includeArchived: true })).toHaveLength(1);
  });

  it('route: merchantOps.catalog.price create, setDefault and quote are wired', async () => {
    const { owner, productId } = await setup();
    const prev = { q: process.env.PAY_CATALOG_QUOTE_QUANTITY_MAX, a: process.env.PAY_CATALOG_ASSET_DECIMALS };
    process.env.PAY_CATALOG_QUOTE_QUANTITY_MAX = '100';
    process.env.PAY_CATALOG_ASSET_DECIMALS = 'USDC:6';
    try {
      const authConfig = {
        secret: 'a-test-signing-secret-that-is-long-enough',
        issuer: 'intafaced',
        audience: 'intafaced.api',
        accessTtlSeconds: 900,
      };
      const { token } = await issueAccessToken(
        { userId: owner.userId, sessionId: randomUUID(), scopes: ['pay:read', 'pay:write'], tier: 'full', mfa: true },
        authConfig,
      );
      const ctx = { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-price' } as Context;
      const api = createMerchantOpsRouter({ sql } as unknown as MerchantOpsDeps).createCaller(ctx);
      const p = await api.merchantOps.catalog.price.create({
        requestId: randomUUID(),
        productId,
        assetId: 'USDC',
        model: 'per_seat',
        unitAmount: '2.5',
        taxBehavior: 'exclusive',
      });
      expect((await api.merchantOps.catalog.price.setDefault({ requestId: randomUUID(), priceId: p.id })).isDefault).toBe(true);
      expect((await api.merchantOps.catalog.price.quote({ priceId: p.id, quantity: 4 })).total).toBe('10');
    } finally {
      if (prev.q === undefined) delete process.env.PAY_CATALOG_QUOTE_QUANTITY_MAX;
      else process.env.PAY_CATALOG_QUOTE_QUANTITY_MAX = prev.q;
      if (prev.a === undefined) delete process.env.PAY_CATALOG_ASSET_DECIMALS;
      else process.env.PAY_CATALOG_ASSET_DECIMALS = prev.a;
    }
  });
  it('quote and setDefault re-check the asset scale: unset, malformed, duplicate, removed or lowered all refuse', async () => {
    const { owner, productId } = await setup();
    const p = await prices.create(owner, { ...seat, assetId: 'USD', unitAmount: '1.05', productId, requestId: randomUUID() });
    const withTable = (t: string | undefined) =>
      new CatalogPriceService(sql, { PAY_CATALOG_QUOTE_QUANTITY_MAX: '10', ...(t === undefined ? {} : { PAY_CATALOG_ASSET_DECIMALS: t }) });
    for (const [table, code] of [
      [undefined, 'pay.catalog_asset_scale_unset'],
      ['USD:x', 'pay.catalog_asset_scale_unset'],
      ['USD:2,USD:2', 'pay.catalog_asset_scale_unset'],
      ['USDC:18', 'pay.catalog_price_asset_unknown'],
      ['USD:1', 'pay.catalog_price_amount_scale'],
    ] as const) {
      const svc = withTable(table);
      expect(await codeOf(svc.quote(owner, { priceId: p.id, quantity: 1 }))).toBe(code);
      expect(await codeOf(svc.setDefault(owner, { requestId: randomUUID(), priceId: p.id }))).toBe(code);
    }
    expect((await withTable(' USD:2 , USDC:6 ').quote(owner, { priceId: p.id, quantity: 2 })).total).toBe('2.1');
  });

  it('a create retried after the scale table changed replays the first result (replay before the scale check)', async () => {
    const { owner, productId } = await setup();
    const requestId = randomUUID();
    const first = await prices.create(owner, { ...seat, assetId: 'USD', unitAmount: '1.05', productId, requestId });
    const lowered = new CatalogPriceService(sql, { PAY_CATALOG_ASSET_DECIMALS: 'USD:1' });
    expect(await lowered.create(owner, { ...seat, assetId: 'USD', unitAmount: '1.05', productId, requestId })).toEqual(first);
  });
});

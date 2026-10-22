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
import { CatalogProductService, roleHasCatalogPermission } from './product-service.js';

/** M-catalogue-01 product records against a real Postgres. */

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

describe('M-catalogue-01 product records (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let catalog!: CatalogProductService;
  let pay!: PayService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
    catalog = new CatalogProductService(sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  async function owner(role: MerchantRole = 'owner'): Promise<MerchantCaller> {
    const userId = randomUUID();
    const m = await pay.createMerchant({ userId, pricing: { feeBps: 0 } });
    return { merchantId: m.id, userId, role, viaApiKey: false, interactive: true };
  }
  const base = { name: 'Monthly box', type: 'good' as const };

  it('create retried with the same requestId returns the first product, and one row exists', async () => {
    const c = await owner();
    const requestId = randomUUID();
    const a = await catalog.create(c, { ...base, requestId, productRef: 'box-1' });
    const b = await catalog.create(c, { ...base, requestId, productRef: 'box-1' });
    expect(b).toEqual(a);
    const [{ n }] = await sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM pay.catalog_products WHERE merchant_id = ${c.merchantId}`;
    expect(n).toBe(1);
  });

  it('the same requestId with other fields is refused', async () => {
    const c = await owner();
    const requestId = randomUUID();
    await catalog.create(c, { ...base, requestId });
    expect(await codeOf(catalog.create(c, { ...base, name: 'Other', requestId }))).toBe('pay.request_id_reused');
  });

  it('product id reused with other fields -> pay.catalog_product_id_taken; same fields -> the same product', async () => {
    const c = await owner();
    const a = await catalog.create(c, { ...base, requestId: randomUUID(), productRef: 'sku.A' });
    expect(await codeOf(catalog.create(c, { ...base, name: 'Different', requestId: randomUUID(), productRef: 'sku.A' }))).toBe(
      'pay.catalog_product_id_taken',
    );
    expect((await catalog.create(c, { ...base, requestId: randomUUID(), productRef: 'sku.A' })).id).toBe(a.id);
  });

  it('the product id is immutable in the database', async () => {
    const c = await owner();
    const a = await catalog.create(c, { ...base, requestId: randomUUID(), productRef: 'fixed-1' });
    await expect(sql`UPDATE pay.catalog_products SET product_ref = 'moved' WHERE id = ${a.id}`).rejects.toThrow(
      /catalog.product_ref_immutable/,
    );
  });

  it('archive twice -> same result; unarchive restores it', async () => {
    const c = await owner();
    const p = await catalog.create(c, { ...base, requestId: randomUUID() });
    const a = await catalog.archive(c, { requestId: randomUUID(), productId: p.id });
    const b = await catalog.archive(c, { requestId: randomUUID(), productId: p.id });
    expect(a.archived).toBe(true);
    expect(b.archivedAt).toBe(a.archivedAt);
    expect((await catalog.unarchive(c, { requestId: randomUUID(), productId: p.id })).archived).toBe(false);
  });

  it('statement descriptor over 22 characters is refused', async () => {
    const c = await owner();
    expect(await codeOf(catalog.create(c, { ...base, requestId: randomUUID(), statementDescriptor: 'X'.repeat(23) }))).toBe(
      'pay.catalog_statement_descriptor_too_long',
    );
    const ok = await catalog.create(c, { ...base, requestId: randomUUID(), statementDescriptor: 'X'.repeat(22) });
    expect(ok.statementDescriptor).toHaveLength(22);
  });

  it('roles without catalog.write are refused; every role reads', async () => {
    const c = await owner();
    const p = await catalog.create(c, { ...base, requestId: randomUUID() });
    for (const role of ['viewer', 'developer', 'finance'] as const) {
      const r = { ...c, role };
      expect(roleHasCatalogPermission(role, 'catalog.write')).toBe(false);
      expect(await codeOf(catalog.create(r, { ...base, requestId: randomUUID() }))).toBe('pay.team_role_forbidden');
      expect(await codeOf(catalog.archive(r, { requestId: randomUUID(), productId: p.id }))).toBe('pay.team_role_forbidden');
      expect((await catalog.get(r, p.id)).id).toBe(p.id);
    }
    expect((await catalog.create({ ...c, role: 'admin' }, { ...base, requestId: randomUUID() })).name).toBe('Monthly box');
  });

  it("another merchant's product reads as not found", async () => {
    const a = await owner();
    const b = await owner();
    const p = await catalog.create(a, { ...base, requestId: randomUUID() });
    expect(await codeOf(catalog.get(b, p.id))).toBe('pay.catalog_product_not_found');
    expect(await codeOf(catalog.update(b, { ...base, requestId: randomUUID(), productId: p.id }))).toBe('pay.catalog_product_not_found');
  });

  it('update edits fields; list pages newest first and filters archived', async () => {
    const c = await owner();
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push((await catalog.create(c, { ...base, name: `P${n}`, requestId: randomUUID() })).id);
    const u = await catalog.update(c, { requestId: randomUUID(), productId: ids[0]!, name: 'Renamed', type: 'service', sku: 'S-1' });
    expect(u).toMatchObject({ name: 'Renamed', type: 'service', sku: 'S-1' });
    await catalog.archive(c, { requestId: randomUUID(), productId: ids[1]! });
    const page1 = await catalog.list(c, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    const page2 = await catalog.list(c, { limit: 5, cursor: page1.nextCursor! });
    expect([...page1.items, ...page2.items].map((p) => p.id).sort()).toEqual([ids[0]!, ids[2]!].sort());
    expect((await catalog.list(c, { limit: 5, archived: true })).items.map((p) => p.id)).toEqual([ids[1]]);
  });
});

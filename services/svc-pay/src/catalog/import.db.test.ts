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
    .withDatabase('intafaced_catalog_import_test')
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

describe('importing a file of products (M-catalogue-01, M-adv-payments-core-21, J-merchant-03 step 5)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = nid();
  const otherOwner = nid();
  const finance = nid();
  let merchant = '';

  const as = (userId: string, over: Partial<Principal> = {}) =>
    createMerchantCatalogRouter({ sql, imageRule: { maxBytes: 100 } }).createCaller(ctxOf(principalOf(userId, over)));
  const run = (csv: string, commit: boolean, who = owner) => as(who).merchantCatalog.products.import({ csv, commit });
  const count = async (merchantId = merchant) =>
    Number((await sql<Array<{ n: string }>>`SELECT count(*) AS n FROM pay.catalog_products WHERE merchant_id = ${merchantId}`)[0]!.n);

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
      VALUES (${merchant}, ${finance}, 'finance', 'active', ${owner}, now())`;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  const unique = () => nid().slice(0, 8);

  it('a dry run lists line-numbered problems and writes nothing; a commit of the same file is refused whole', async () => {
    const u = unique();
    const csv = `name,type,product_id\nTEST Mug ${u},physical,mug-${u}\nTEST Toy ${u},toy,\nTEST Pen ${u},physical,\n`;
    const before = await count();
    const dry = await run(csv, false);
    expect(dry).toMatchObject({ rows: 3, problemCount: 1, imported: false, replayed: false, importedAt: null, products: [] });
    expect(dry.problems).toEqual([{ line: 3, column: 'type', problem: 'value_invalid' }]);
    expect(await refusal(() => run(csv, true))).toEqual({ code: 'BAD_REQUEST', cause: 'pay.product_import_invalid' });
    expect(await count()).toBe(before);
    expect((await sql`SELECT 1 FROM pay.catalog_product_imports WHERE file_sha256 = ${dry.fileSha256}`).length).toBe(0);
  });

  it('a commit writes every product once, in file order; the same file again is a replay that makes nothing', async () => {
    const u = unique();
    const csv = `name,type,product_id,event_starts_at,event_location\nTEST Mug ${u},physical,mug-${u},,\nTEST Talk ${u},event,,2026-12-01T19:00:00Z,TEST Hall\n`;
    const before = await count();
    const dry = await run(csv, false);
    expect(dry).toMatchObject({ rows: 2, problems: [], problemCount: 0, imported: false });
    expect(await count()).toBe(before);
    const done = await run(csv, true);
    expect(done).toMatchObject({ rows: 2, imported: true, replayed: false, fileSha256: dry.fileSha256 });
    expect(done.products.map((p) => [p.name, p.productKey, p.type, p.mode, p.event])).toEqual([
      [`TEST Mug ${u}`, `mug-${u}`, 'physical', 'live', null],
      [
        `TEST Talk ${u}`,
        expect.stringMatching(/^prod_[a-z2-7]{16}$/),
        'event',
        'live',
        { startsAt: '2026-12-01T19:00:00.000Z', location: 'TEST Hall' },
      ],
    ]);
    expect(await count()).toBe(before + 2);
    for (const commit of [true, false]) {
      const again = await run(csv, commit);
      expect(again).toMatchObject({ imported: true, replayed: true, importedAt: done.importedAt });
      expect(again.products.map((p) => p.id)).toEqual(done.products.map((p) => p.id));
    }
    expect(await count()).toBe(before + 2);
  });

  it('a chosen id already in the catalogue is a problem on its line, and two commits racing for one id make it once', async () => {
    const u = unique();
    await as(owner).merchantCatalog.products.create({ requestId: nid(), productKey: `taken-${u}`, name: 'TEST Taken', type: 'digital' });
    const dry = await run(`name,type,product_id\nTEST One ${u},digital,\nTEST Two ${u},digital,taken-${u}\n`, false);
    expect(dry.problems).toEqual([{ line: 3, column: 'product_id', problem: 'id_taken' }]);

    const before = await count();
    const a = `name,type,product_id\nTEST Race A ${u},digital,race-${u}\n`;
    const b = `name,type,product_id\nTEST Race B ${u},service,race-${u}\n`;
    const results = await Promise.allSettled([run(a, true), run(b, true)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as { cause?: { code?: string } }).cause?.code).toBe('pay.product_import_invalid');
    expect(await count()).toBe(before + 1);
  });

  it('two commits of one file at once make its products once', async () => {
    const u = unique();
    const csv = `name,type\nTEST Twin ${u},digital\n`;
    const before = await count();
    const [x, y] = await Promise.all([run(csv, true), run(csv, true)]);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect(x.products[0]!.id).toBe(y.products[0]!.id);
    expect(await count()).toBe(before + 1);
  });

  it('a product the file made and that was deleted since is left out of the replay, and is not made again', async () => {
    const u = unique();
    const csv = `name,type\nTEST Gone ${u},digital\nTEST Kept ${u},digital\n`;
    const done = await run(csv, true);
    await as(owner).merchantCatalog.products.delete({ productId: done.products[0]!.id });
    const again = await run(csv, true);
    expect(again.replayed).toBe(true);
    expect(again.products.map((p) => p.name)).toEqual([`TEST Kept ${u}`]);
  });

  it('another business importing the same file gets its own products', async () => {
    const u = unique();
    const csv = `name,type,product_id\nTEST Shared ${u},digital,shared-${u}\n`;
    const mine = await run(csv, true);
    const theirs = await run(csv, true, otherOwner);
    expect(theirs.replayed).toBe(false);
    expect(theirs.products[0]!.id).not.toBe(mine.products[0]!.id);
  });

  it('finance and a session without a second factor cannot import, not even a dry run', async () => {
    const csv = `name,type\nTEST Nope,digital\n`;
    expect(await refusal(() => run(csv, false, finance))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await refusal(() => as(owner, { mfa: false }).merchantCatalog.products.import({ csv, commit: false }))).toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses an empty file and keeps an import row as written', async () => {
    expect(await refusal(() => run('name,type\n', false))).toEqual({ code: 'BAD_REQUEST', cause: 'pay.product_import_empty' });
    const done = await run(`name,type\nTEST Kept row ${unique()},digital\n`, true);
    const err = await sql`UPDATE pay.catalog_product_imports SET row_count = 2 WHERE file_sha256 = ${done.fileSha256}`.catch(
      (e: { code?: string }) => e,
    );
    expect((err as { code?: string }).code).toBe('23001');
  });
});

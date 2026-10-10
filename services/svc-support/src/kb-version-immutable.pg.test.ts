import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getKb } from './kb-catalog.js';
import { PostgresSupportStore } from './store.js';

/**
 * L1242 — a published KB generation cannot be replaced in place.
 * kb_article_versions refuses UPDATE and row removal, so getKb({ id, version })
 * keeps the body that generation was stored with. A kb_articles title_key or
 * body_key change must bump revision and insert the matching version row.
 * Same per-run database as citation-shape.pg.test.ts. The migrated name ends
 * in _test and is never intafaced_test.
 */

const ADMIN_URL = 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_l1242_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;

const TITLE = 'support.kb.account_access.title';
const BODY = 'support.kb.account_access.body';
const TITLE_NEXT = 'support.kb.security_basics.title';
const BODY_NEXT = 'support.kb.account_access.body_v2';

const SEEDED: readonly (readonly [string, string, string])[] = [
  ['kb-account-access', 'support.kb.account_access.title', 'support.kb.account_access.body'],
  ['kb-security-basics', 'support.kb.security_basics.title', 'support.kb.security_basics.body'],
  ['kb-orders-status', 'support.kb.orders_status.title', 'support.kb.orders_status.body'],
  ['kb-deposit-withdraw-honest', 'support.kb.deposit_withdraw.title', 'support.kb.deposit_withdraw.body'],
  ['kb-paper-vs-live', 'support.kb.paper_vs_live.title', 'support.kb.paper_vs_live.body'],
];

if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) {
  throw new Error(`refusing database name ${database}`);
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let created = false;

function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') return err.code;
  return undefined;
}

async function tryCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return pgCode(err);
  }
}

async function bodyAt(id: string, version: number): Promise<string | undefined> {
  const history = await new PostgresSupportStore(sql).listKbVersions(id);
  return getKb({ id, version }, history)?.bodyKey;
}

async function headOf(id: string): Promise<{ title_key: string; body_key: string; revision: number } | undefined> {
  const rows = await sql<{ title_key: string; body_key: string; revision: number }[]>`
    SELECT title_key, body_key, revision FROM support.kb_articles WHERE id = ${id}
  `;
  return rows[0];
}

async function seedPair(id: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO support.kb_articles (id, title_key, body_key, revision, published)
      VALUES (${id}, ${TITLE}, ${BODY}, 1, true)
    `;
    await tx`
      INSERT INTO support.kb_article_versions (id, version, title_key, body_key)
      VALUES (${id}, 1, ${TITLE}, ${BODY})
    `;
  });
}

beforeAll(async () => {
  const adminDb = await admin<{ db: string }[]>`SELECT current_database() AS db`;
  if (adminDb[0]?.db !== 'postgres') {
    throw new Error(`admin connection is on ${adminDb[0]?.db ?? '<none>'}, expected postgres`);
  }
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  created = true;

  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });

  const live = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  if (live[0]?.db !== database || !live[0]?.db.endsWith('_test') || live[0]?.db === 'intafaced_test') {
    throw new Error(`refusing to migrate ${live[0]?.db ?? '<none>'}`);
  }

  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
  const ups = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
  for (const file of ups) {
    await sql.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
  }
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

describe('L1242 KB versions stay immutable', () => {
  it('keeps the backfill bodies for the seeded generations', async () => {
    for (const [id, title, body] of SEEDED) {
      expect(await bodyAt(id, 1), id).toBe(body);
      expect(await headOf(id), id).toMatchObject({ title_key: title, body_key: body, revision: 1 });
    }
  });

  it('refuses an update of a version row and getKb returns the original body', async () => {
    const id = 'kb-l1242-version-update';
    await seedPair(id);
    expect(await bodyAt(id, 1)).toBe(BODY);
    const body = await tryCode(
      () => sql`
        UPDATE support.kb_article_versions
        SET body_key = ${BODY_NEXT}
        WHERE id = ${id} AND version = 1
      `,
    );
    const title = await tryCode(
      () => sql`
        UPDATE support.kb_article_versions
        SET title_key = ${TITLE_NEXT}
        WHERE id = ${id} AND version = 1
      `,
    );
    expect(body, 'version body update replaced the generation').toBe('23514');
    expect(title, 'version title update replaced the generation').toBe('23514');
    expect(await bodyAt(id, 1)).toBe(BODY);
    expect(await headOf(id)).toMatchObject({ title_key: TITLE, body_key: BODY, revision: 1 });
  });

  it('refuses removal of a version row and getKb returns the original body', async () => {
    const id = 'kb-l1242-version-remove';
    await seedPair(id);
    const code = await tryCode(() => sql`DELETE FROM support.kb_article_versions WHERE id = ${id} AND version = 1`);
    expect(code, 'version removal dropped the generation').toBe('23514');
    expect(await bodyAt(id, 1)).toBe(BODY);
  });

  it('refuses an in-place title_key or body_key change that does not bump revision', async () => {
    const titleId = 'kb-l1242-head-title';
    const bodyId = 'kb-l1242-head-body';
    await seedPair(titleId);
    await seedPair(bodyId);
    const title = await tryCode(
      () => sql`
        UPDATE support.kb_articles
        SET title_key = ${TITLE_NEXT}
        WHERE id = ${titleId}
      `,
    );
    const body = await tryCode(
      () => sql`
        UPDATE support.kb_articles
        SET body_key = ${BODY_NEXT}
        WHERE id = ${bodyId}
      `,
    );
    expect(title, 'head title changed without a new generation').toBe('23514');
    expect(body, 'head body changed without a new generation').toBe('23514');
    expect(await headOf(titleId)).toMatchObject({ title_key: TITLE, body_key: BODY, revision: 1 });
    expect(await headOf(bodyId)).toMatchObject({ title_key: TITLE, body_key: BODY, revision: 1 });
    expect(await bodyAt(titleId, 1)).toBe(BODY);
    expect(await bodyAt(bodyId, 1)).toBe(BODY);
  });

  it('refuses a revision bump that does not insert the matching version row', async () => {
    const id = 'kb-l1242-bump-without-version';
    await seedPair(id);
    const code = await tryCode(
      () => sql`
        UPDATE support.kb_articles
        SET body_key = ${BODY_NEXT}, revision = revision + 1
        WHERE id = ${id}
      `,
    );
    expect(code, 'head moved to a generation with no version row').toBe('23514');
    expect(await headOf(id)).toMatchObject({ title_key: TITLE, body_key: BODY, revision: 1 });
    expect(await bodyAt(id, 1)).toBe(BODY);
  });

  it('refuses a bumped head whose version row carries different keys', async () => {
    const id = 'kb-l1242-disagree';
    await seedPair(id);
    const code = await tryCode(() =>
      sql.begin(async (tx) => {
        await tx`
          UPDATE support.kb_articles
          SET body_key = ${BODY_NEXT}, revision = revision + 1
          WHERE id = ${id}
        `;
        await tx`
          INSERT INTO support.kb_article_versions (id, version, title_key, body_key)
          VALUES (${id}, 2, ${TITLE}, ${BODY})
        `;
      }),
    );
    expect(code, 'head and version row disagree for the same number').toBe('23514');
    expect(await headOf(id)).toMatchObject({ title_key: TITLE, body_key: BODY, revision: 1 });
    expect(await bodyAt(id, 1)).toBe(BODY);
    const versions = await sql<{ version: number }[]>`
      SELECT version FROM support.kb_article_versions WHERE id = ${id} ORDER BY version
    `;
    expect(versions.map((row) => row.version)).toEqual([1]);
  });

  it('refuses a version row that disagrees with the head already on that number', async () => {
    const id = 'kb-l1242-version-disagree';
    const code = await tryCode(() =>
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO support.kb_articles (id, title_key, body_key, revision, published)
          VALUES (${id}, ${TITLE}, ${BODY}, 1, true)
        `;
        await tx`
          INSERT INTO support.kb_article_versions (id, version, title_key, body_key)
          VALUES (${id}, 1, ${TITLE}, ${BODY_NEXT})
        `;
      }),
    );
    expect(code, 'version insert disagreed with the head').toBe('23514');
    expect(await headOf(id)).toBeUndefined();
    expect(await bodyAt(id, 1)).toBeUndefined();
  });

  it('a revision bump that inserts the matching version row keeps the prior body', async () => {
    const id = 'kb-l1242-publish';
    await seedPair(id);
    const store = new PostgresSupportStore(sql);
    const bumped = await store.putKbRevision({
      id,
      titleKey: TITLE_NEXT,
      bodyKey: BODY_NEXT,
      baseRevision: 1,
      published: true,
    });
    expect(bumped).toMatchObject({
      status: 'ok',
      article: { id, titleKey: TITLE_NEXT, bodyKey: BODY_NEXT, revision: 2, version: 2 },
    });
    const history = await store.listKbVersions(id);
    expect(getKb({ id, version: 1 }, history)?.bodyKey).toBe(BODY);
    expect(getKb({ id, version: 2 }, history)).toMatchObject({
      titleKey: TITLE_NEXT,
      bodyKey: BODY_NEXT,
      version: 2,
    });
    expect(await headOf(id)).toMatchObject({ title_key: TITLE_NEXT, body_key: BODY_NEXT, revision: 2 });
  });

  it('unpublish still flips published without a new generation', async () => {
    const id = 'kb-l1242-unpublish';
    await seedPair(id);
    const hidden = await new PostgresSupportStore(sql).putKbRevision({ id, baseRevision: 1, published: false });
    expect(hidden).toMatchObject({ status: 'ok', article: { published: false, revision: 1, bodyKey: BODY } });
    expect(await bodyAt(id, 1)).toBe(BODY);
    expect(await new PostgresSupportStore(sql).getPublishedKb(id)).toBeNull();
  });
});

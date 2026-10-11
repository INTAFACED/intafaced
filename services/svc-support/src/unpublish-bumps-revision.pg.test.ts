import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemorySupportStore, PostgresSupportStore } from './store.js';

/**
 * L1247 — unpublish must bump revision. Title and body stay the stored keys.
 * The article stays unpublished. A later publish that still sends the old
 * baseRevision returns revision_stale and leaves published false. A publish
 * that sends the new revision can publish again. No amount column. No ledger
 * entry. The migrated name ends in _test and is never intafaced_test.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_l1247_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;

const TITLE = 'support.kb.account_access.title';
const BODY = 'support.kb.account_access.body';
const ID_BUMP = 'kb-account-access';
const ID_STALE = 'kb-security-basics';
const ID_AGAIN = 'kb-orders-status';

if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) {
  throw new Error(`refusing database name ${database}`);
}

describe('L1247 memory unpublish bumps revision', () => {
  it('bumps revision, keeps the stored keys, and stays unpublished', async () => {
    const store = new MemorySupportStore();
    const before = await store.getPublishedKb(ID_BUMP);
    expect(before).toMatchObject({ titleKey: TITLE, bodyKey: BODY, revision: 1, published: true });

    const hidden = await store.putKbRevision({ id: ID_BUMP, baseRevision: 1, published: false });
    expect(hidden).toMatchObject({
      status: 'ok',
      article: { id: ID_BUMP, titleKey: TITLE, bodyKey: BODY, revision: 2, version: 2, published: false },
    });
    if (hidden.status === 'ok') expect(hidden.article).not.toHaveProperty('amount');
    expect(await store.getPublishedKb(ID_BUMP)).toBeNull();
    expect(await store.listKbVersions(ID_BUMP)).toEqual([
      expect.objectContaining({ version: 1, titleKey: TITLE, bodyKey: BODY }),
      expect.objectContaining({ version: 2, titleKey: TITLE, bodyKey: BODY }),
    ]);
  });

  it('refuses a later publish that still sends the old baseRevision', async () => {
    const store = new MemorySupportStore();
    const before = await store.getPublishedKb(ID_STALE);
    expect(before?.revision).toBe(1);
    const titleKey = before?.titleKey ?? '';
    const bodyKey = before?.bodyKey ?? '';

    const hidden = await store.putKbRevision({ id: ID_STALE, baseRevision: 1, published: false });
    expect(hidden.status).toBe('ok');

    const stale = await store.putKbRevision({
      id: ID_STALE,
      titleKey,
      bodyKey,
      baseRevision: 1,
      published: true,
    });
    expect(stale).toEqual({ status: 'refuse', reason: 'revision_stale' });
    expect(await store.getPublishedKb(ID_STALE)).toBeNull();
    expect(await store.listKbVersions(ID_STALE)).toHaveLength(2);
  });

  it('publishes again when the caller sends the revision unpublish wrote', async () => {
    const store = new MemorySupportStore();
    const before = await store.getPublishedKb(ID_AGAIN);
    expect(before).toMatchObject({ revision: 1, published: true });
    const titleKey = before?.titleKey ?? '';
    const bodyKey = before?.bodyKey ?? '';

    const hidden = await store.putKbRevision({ id: ID_AGAIN, baseRevision: 1, published: false });
    expect(hidden).toMatchObject({ status: 'ok', article: { revision: 2, published: false, titleKey, bodyKey } });

    const again = await store.putKbRevision({
      id: ID_AGAIN,
      titleKey,
      bodyKey,
      baseRevision: 2,
      published: true,
    });
    expect(again).toMatchObject({
      status: 'ok',
      article: { id: ID_AGAIN, titleKey, bodyKey, revision: 3, version: 3, published: true },
    });
    expect(await store.getPublishedKb(ID_AGAIN)).toMatchObject({
      titleKey,
      bodyKey,
      revision: 3,
      published: true,
    });
  });
});

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let created = false;

describe('L1247 postgres unpublish bumps revision', () => {
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

  async function headOf(id: string): Promise<{ title_key: string; body_key: string; revision: number; published: boolean } | undefined> {
    const rows = await sql<{ title_key: string; body_key: string; revision: number; published: boolean }[]>`
      SELECT title_key, body_key, revision, published FROM support.kb_articles WHERE id = ${id}
    `;
    return rows[0];
  }

  async function versionsOf(id: string): Promise<{ version: number; title_key: string; body_key: string }[]> {
    return sql<{ version: number; title_key: string; body_key: string }[]>`
      SELECT version, title_key, body_key
      FROM support.kb_article_versions
      WHERE id = ${id}
      ORDER BY version
    `;
  }

  it('migrates the per-run database and has no amount column and no ledger schema', async () => {
    const live = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    expect(live[0]?.db).toBe(database);
    expect(live[0]?.db).not.toBe('intafaced_test');
    expect(live[0]?.db.endsWith('_test')).toBe(true);

    const amount = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'support'
        AND table_name IN ('kb_articles', 'kb_article_versions')
        AND column_name = 'amount'
    `;
    expect(amount).toHaveLength(0);

    const ledger = await sql<{ nspname: string }[]>`
      SELECT nspname FROM pg_namespace WHERE nspname = 'ledger'
    `;
    expect(ledger).toHaveLength(0);
  });

  it('bumps revision, copies the stored keys into the new version row, and stays unpublished', async () => {
    const live = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    expect(live[0]?.db).toBe(database);

    const store = new PostgresSupportStore(sql);
    const before = await store.getPublishedKb(ID_BUMP);
    expect(before).toMatchObject({ titleKey: TITLE, bodyKey: BODY, revision: 1, published: true });

    const hidden = await store.putKbRevision({ id: ID_BUMP, baseRevision: 1, published: false });
    expect(hidden).toMatchObject({
      status: 'ok',
      article: { id: ID_BUMP, titleKey: TITLE, bodyKey: BODY, revision: 2, version: 2, published: false },
    });
    if (hidden.status === 'ok') expect(hidden.article).not.toHaveProperty('amount');
    expect(await store.getPublishedKb(ID_BUMP)).toBeNull();
    expect(await headOf(ID_BUMP)).toMatchObject({ title_key: TITLE, body_key: BODY, revision: 2, published: false });
    expect(await versionsOf(ID_BUMP)).toEqual([
      { version: 1, title_key: TITLE, body_key: BODY },
      { version: 2, title_key: TITLE, body_key: BODY },
    ]);
  });

  it('refuses a later publish that still sends the old baseRevision and leaves the row hidden', async () => {
    const live = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    expect(live[0]?.db).toBe(database);

    const store = new PostgresSupportStore(sql);
    const before = await store.getPublishedKb(ID_STALE);
    expect(before?.published).toBe(true);
    const titleKey = before?.titleKey ?? '';
    const bodyKey = before?.bodyKey ?? '';
    expect(titleKey.startsWith('support.kb.')).toBe(true);
    expect(bodyKey.startsWith('support.kb.')).toBe(true);

    const hidden = await store.putKbRevision({ id: ID_STALE, baseRevision: 1, published: false });
    expect(hidden.status).toBe('ok');

    const stale = await store.putKbRevision({
      id: ID_STALE,
      titleKey,
      bodyKey,
      baseRevision: 1,
      published: true,
    });
    expect(stale).toEqual({ status: 'refuse', reason: 'revision_stale' });
    expect(await store.getPublishedKb(ID_STALE)).toBeNull();
    expect(await headOf(ID_STALE)).toMatchObject({
      title_key: titleKey,
      body_key: bodyKey,
      revision: 2,
      published: false,
    });
    expect(await versionsOf(ID_STALE)).toEqual([
      { version: 1, title_key: titleKey, body_key: bodyKey },
      { version: 2, title_key: titleKey, body_key: bodyKey },
    ]);
  });

  it('publishes again when the caller sends the revision unpublish wrote', async () => {
    const store = new PostgresSupportStore(sql);
    const before = await store.getPublishedKb(ID_AGAIN);
    expect(before).toMatchObject({ revision: 1, published: true });
    const titleKey = before?.titleKey ?? '';
    const bodyKey = before?.bodyKey ?? '';

    const hidden = await store.putKbRevision({ id: ID_AGAIN, baseRevision: 1, published: false });
    expect(hidden).toMatchObject({
      status: 'ok',
      article: { revision: 2, published: false, titleKey, bodyKey },
    });

    const again = await store.putKbRevision({
      id: ID_AGAIN,
      titleKey,
      bodyKey,
      baseRevision: 2,
      published: true,
    });
    expect(again).toMatchObject({
      status: 'ok',
      article: { id: ID_AGAIN, titleKey, bodyKey, revision: 3, version: 3, published: true },
    });
    if (again.status === 'ok') expect(again.article).not.toHaveProperty('amount');
    expect(await store.getPublishedKb(ID_AGAIN)).toMatchObject({
      titleKey,
      bodyKey,
      revision: 3,
      published: true,
    });
    expect(await headOf(ID_AGAIN)).toMatchObject({
      title_key: titleKey,
      body_key: bodyKey,
      revision: 3,
      published: true,
    });
    expect(await versionsOf(ID_AGAIN)).toEqual([
      { version: 1, title_key: titleKey, body_key: bodyKey },
      { version: 2, title_key: titleKey, body_key: bodyKey },
      { version: 3, title_key: titleKey, body_key: bodyKey },
    ]);
  });
});

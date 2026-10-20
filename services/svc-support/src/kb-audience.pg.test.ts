import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSupportStore } from './store.js';

/**
 * SP-help-centre-02 — the audience is stored on the immutable version row, a change writes a new
 * version and one audit row, and a republish or unpublish keeps it. Per-run database as in
 * unpublish-bumps-revision.pg.test.ts; the name ends in _test and is never intafaced_test.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_kbaud_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
const ACTOR = 'actor-1';

if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) {
  throw new Error(`refusing database name ${database}`);
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let store: PostgresSupportStore;
let created = false;

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const f of files) await sql.unsafe(readFileSync(join(migrationsDir, f), 'utf8'));
  store = new PostgresSupportStore(sql);
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

const publish = (id: string, baseRevision: number, bodyKey = `support.kb.${id}.body`) =>
  store.putKbRevision({ id, baseRevision, published: true, titleKey: `support.kb.${id}.title`, bodyKey, category: 'account' });

describe('article audience on postgres', () => {
  it('starts public, changes in a new version with one audit row, and a repeat changes nothing', async () => {
    await publish('kb-aud-one', 0);
    expect((await store.getPublishedKb('kb-aud-one'))?.audience ?? 'public').toBe('public');

    const set = await store.setKbAudience({ id: 'kb-aud-one', baseRevision: 1, audience: 'signed_in', actorId: ACTOR });
    expect(set).toMatchObject({
      status: 'ok',
      changed: true,
      article: { revision: 2, audience: 'signed_in', category: 'account', published: true },
    });
    const repeat = await store.setKbAudience({ id: 'kb-aud-one', baseRevision: 2, audience: 'signed_in', actorId: ACTOR });
    expect(repeat).toMatchObject({ status: 'ok', changed: false, article: { revision: 2 } });

    const versions = await store.listKbVersions('kb-aud-one');
    expect(versions.map((v) => [v.version, v.audience ?? 'public'])).toEqual([
      [1, 'public'],
      [2, 'signed_in'],
    ]);
    expect(await store.listKbAudienceChanges('kb-aud-one')).toEqual([
      expect.objectContaining({ fromAudience: 'public', toAudience: 'signed_in', fromRevision: 1, toRevision: 2, actorId: ACTOR }),
    ]);
  });

  it('refuses a stale revision and an unknown article, and writes nothing', async () => {
    await publish('kb-aud-two', 0);
    expect(await store.setKbAudience({ id: 'kb-aud-two', baseRevision: 7, audience: 'staff', actorId: ACTOR })).toEqual({
      status: 'refuse',
      reason: 'revision_stale',
    });
    expect(await store.setKbAudience({ id: 'kb-aud-missing', baseRevision: 1, audience: 'staff', actorId: ACTOR })).toEqual({
      status: 'refuse',
      reason: 'invalid',
    });
    expect(await store.listKbAudienceChanges('kb-aud-two')).toEqual([]);
    expect((await store.listKbVersions('kb-aud-two')).length).toBe(1);
  });

  it('a republish and an unpublish keep the audience', async () => {
    await publish('kb-aud-three', 0);
    await store.setKbAudience({ id: 'kb-aud-three', baseRevision: 1, audience: 'staff', actorId: ACTOR });
    const again = await publish('kb-aud-three', 2, 'support.kb.kb-aud-three.body2');
    expect(again).toMatchObject({ status: 'ok', article: { revision: 3, audience: 'staff' } });
    const hidden = await store.putKbRevision({ id: 'kb-aud-three', baseRevision: 3, published: false });
    expect(hidden).toMatchObject({ status: 'ok', article: { revision: 4, audience: 'staff', published: false } });
    expect((await store.listKbVersions('kb-aud-three')).map((v) => v.audience ?? 'public')).toEqual(['public', 'staff', 'staff', 'staff']);
  });

  it('the audit table refuses update and delete, and the column refuses an unknown audience', async () => {
    await expect(sql`UPDATE support.kb_audience_changes SET actor_id = 'x'`).rejects.toThrow();
    await expect(sql`DELETE FROM support.kb_audience_changes`).rejects.toThrow();
    await expect(
      sql`INSERT INTO support.kb_article_versions (id, version, title_key, body_key, audience) VALUES ('kb-bad', 1, 't', 'b', 'everyone')`,
    ).rejects.toThrow();
  });
});

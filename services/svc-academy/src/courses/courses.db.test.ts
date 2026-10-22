/**
 * AC-course-structure-01 — course store and admin doors against PostgreSQL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { AcademyService } from '../academy-service.js';
import { createAcademyRouter } from '../router.js';
import { AcademyCourseStore } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
const sql = db.sql;
const ACTOR = '11111111-1111-4111-8111-111111111111';
const SECRET = 'academy-course-structure-edge-secret-32';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

let clock = new Date('2026-10-22T00:00:00.000Z');
const store = () => new AcademyCourseStore(sql, () => clock);

function caller(scopes: string[]) {
  const p = {
    sub: ACTOR,
    userId: ACTOR,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as unknown as Principal;
  const raw = encodePrincipal(p);
  const ctx = edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-courses',
  });
  return createAcademyRouter({} as AcademyService, {}, undefined, undefined, null, store()).createCaller(ctx);
}

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
  clock = new Date('2026-10-22T00:00:00.000Z');
});

const create = (over: Partial<Parameters<AcademyCourseStore['create']>[0]> = {}) =>
  store().create({ slug: 'intro', title: 'TEST course', priceChoice: 'free', actor: ACTOR, ...over });

describe('AcademyCourseStore (AC-course-structure-01)', () => {
  it('create is idempotent by slug and writes one create event', async () => {
    const a = await create();
    const b = await create({ title: 'other' });
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ state: 'draft', listed: false, revision: 0, price: null });
    const events = await store().events(a.id, 10);
    expect(events).toHaveLength(1);
  });

  it('create refuses a reserved slug and a blank title', async () => {
    await expect(create({ slug: 'videos' })).rejects.toMatchObject({ code: 'academy.slug_reserved' });
    await expect(create({ title: '  ' })).rejects.toMatchObject({ code: 'academy.course_invalid' });
  });

  it('price round-trips as a decimal string', async () => {
    const c = await create({ priceChoice: 'paid', price: '12.5' });
    expect(c.price).toMatch(/^12\.50*$/);
  });

  it('paid without price refuses publish with academy.price_unset; setPrice then publish lists it', async () => {
    const c = await create({ priceChoice: 'paid' });
    await expect(store().move({ courseId: c.id, move: 'publish', revision: 0, actor: ACTOR, reason: 'go' })).rejects.toMatchObject({
      code: 'academy.price_unset',
    });
    const priced = await store().setPrice({ courseId: c.id, price: '9', revision: 0, actor: ACTOR, reason: 'priced' });
    expect(priced.revision).toBe(1);
    const p = await store().move({ courseId: c.id, move: 'publish', revision: 1, actor: ACTOR, reason: 'go' });
    expect(p).toMatchObject({ state: 'published', listed: true, revision: 2 });
    await expect(store().setPrice({ courseId: c.id, price: '10', revision: 2, actor: ACTOR, reason: 'later' })).rejects.toMatchObject({
      code: 'academy.item_transition_illegal',
    });
  });

  it('a repeated move returns the stored result and moves once', async () => {
    const c = await create();
    const m = { courseId: c.id, move: 'publish' as const, revision: 0, actor: ACTOR, reason: 'go' };
    const first = await store().move(m);
    const again = await store().move(m);
    expect(again).toEqual(first);
    expect(await store().events(c.id, 10)).toHaveLength(2);
  });

  it('a stale revision refuses academy.item_transition_illegal', async () => {
    const c = await create();
    await store().move({ courseId: c.id, move: 'publish', revision: 0, actor: ACTOR, reason: 'go' });
    await expect(store().move({ courseId: c.id, move: 'conclude', revision: 0, actor: ACTOR, reason: 'x' })).rejects.toMatchObject({
      code: 'academy.item_transition_illegal',
    });
  });

  it('a move needs a reason', async () => {
    const c = await create();
    await expect(store().move({ courseId: c.id, move: 'publish', revision: 0, actor: ACTOR, reason: ' ' })).rejects.toMatchObject({
      code: 'academy.course_invalid',
    });
  });

  it('unknown course refuses academy.course_not_found', async () => {
    const id = '99999999-9999-4999-8999-999999999999';
    await expect(store().get(id)).rejects.toMatchObject({ code: 'academy.course_not_found' });
    await expect(store().move({ courseId: id, move: 'publish', revision: 0, actor: ACTOR, reason: 'go' })).rejects.toMatchObject({
      code: 'academy.course_not_found',
    });
  });

  it('delete refuses academy.undelete_window_unset while the window is blank', async () => {
    const c = await create();
    await expect(store().move({ courseId: c.id, move: 'delete', revision: 0, actor: ACTOR, reason: 'gone' })).rejects.toMatchObject({
      code: 'academy.undelete_window_unset',
    });
  });

  it('delete keeps the row and other tables; undelete inside the window restores; outside refuses', async () => {
    await store().setSetting('undelete_window_seconds', '60', ACTOR, 'TEST window');
    const c = await create();
    await store().move({ courseId: c.id, move: 'publish', revision: 0, actor: ACTOR, reason: 'go' });
    const d = await store().move({ courseId: c.id, move: 'delete', revision: 1, actor: ACTOR, reason: 'gone' });
    expect(d).toMatchObject({ state: 'deleted', listed: false });
    expect((await sql`SELECT 1 FROM academy.courses WHERE id = ${c.id}`).length).toBe(1);
    clock = new Date(clock.getTime() + 30_000);
    const u = await store().move({ courseId: c.id, move: 'undelete', revision: 2, actor: ACTOR, reason: 'back' });
    expect(u).toMatchObject({ state: 'published', listed: true });
    await store().move({ courseId: c.id, move: 'delete', revision: 3, actor: ACTOR, reason: 'gone again' });
    clock = new Date(clock.getTime() + 61_000);
    await expect(store().move({ courseId: c.id, move: 'undelete', revision: 4, actor: ACTOR, reason: 'late' })).rejects.toMatchObject({
      code: 'academy.item_transition_illegal',
    });
  });

  it('settings report not_set until set; a bad value refuses', async () => {
    expect(await store().settings()).toEqual([{ key: 'undelete_window_seconds', state: 'not_set', value: null }]);
    await expect(store().setSetting('undelete_window_seconds', '0', ACTOR, 'TEST')).rejects.toMatchObject({
      code: 'academy.course_invalid',
    });
    await store().setSetting('undelete_window_seconds', '120', ACTOR, 'TEST');
    expect(await store().settings()).toEqual([{ key: 'undelete_window_seconds', state: 'set', value: '120' }]);
  });
});

describe('audit rows (review fix)', () => {
  it('setPrice writes a course event with actor and reason and bumps the revision', async () => {
    const c = await create({ priceChoice: 'paid' });
    const m = { courseId: c.id, price: '9', revision: 0, actor: ACTOR, reason: 'TEST price reason' };
    const first = await store().setPrice(m);
    const again = await store().setPrice(m);
    expect(again).toEqual(first);
    const rows = await sql<Array<{ idempotency_key: string; actor: string; reason: string; revision: number }>>`
      SELECT idempotency_key, actor, reason, revision FROM academy.course_events WHERE course_id = ${c.id} AND idempotency_key LIKE 'price:%'`;
    expect(rows).toEqual([{ idempotency_key: `price:${c.id}:0`, actor: ACTOR, reason: 'TEST price reason', revision: 1 }]);
    await expect(store().setPrice({ ...m, revision: 1, reason: ' ' })).rejects.toMatchObject({ code: 'academy.course_invalid' });
    await expect(store().setPrice({ ...m, price: '11', reason: 'stale' })).resolves.toEqual(first);
    await expect(store().setPrice({ ...m, revision: 5, reason: 'stale' })).rejects.toMatchObject({
      code: 'academy.item_transition_illegal',
    });
    expect((await store().get(c.id)).revision).toBe(1);
  });

  it('setSetting needs a reason and appends one history row per change', async () => {
    await expect(store().setSetting('undelete_window_seconds', '60', ACTOR, ' ')).rejects.toMatchObject({ code: 'academy.course_invalid' });
    await store().setSetting('undelete_window_seconds', '60', ACTOR, 'TEST first');
    await store().setSetting('undelete_window_seconds', '60', ACTOR, 'TEST repeat');
    await store().setSetting('undelete_window_seconds', '90', ACTOR, 'TEST second');
    const rows = await sql<Array<{ value: string; actor: string; reason: string }>>`
      SELECT value, actor, reason FROM academy.course_settings_events ORDER BY id`;
    expect(rows).toEqual([
      { value: '60', actor: ACTOR, reason: 'TEST first' },
      { value: '90', actor: ACTOR, reason: 'TEST second' },
    ]);
  });
});

describe('admin course doors', () => {
  it('admin:write creates and moves; refusals map to tRPC codes', async () => {
    const c = await caller(['admin:read', 'admin:write']).admin.createCourse({ slug: 'door', title: 'TEST', priceChoice: 'paid' });
    await expect(
      caller(['admin:write']).admin.setCourseLifecycle({ courseId: c.id, move: 'publish', revision: 0, reason: 'go' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller(['admin:write']).admin.createCourse({ slug: 'videos', title: 'x', priceChoice: 'free' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect((await caller(['admin:read']).admin.course({ courseId: c.id })).slug).toBe('door');
  });

  it('blank reason refuses at the door with academy.course_invalid', async () => {
    const w = caller(['admin:read', 'admin:write']);
    const c = await w.admin.createCourse({ slug: 'reasons', title: 'TEST', priceChoice: 'paid' });
    const cause = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        return (err as { cause?: { code?: string } }).cause?.code;
      }
      return undefined;
    };
    expect(await cause(w.admin.setCoursePrice({ courseId: c.id, price: '9', revision: 0, reason: ' ' }))).toBe('academy.course_invalid');
    expect(await cause(w.admin.setCourseSetting({ key: 'undelete_window_seconds', value: '60', reason: ' ' }))).toBe(
      'academy.course_invalid',
    );
  });

  it('a learner session is refused', async () => {
    await expect(
      caller(['academy:read', 'academy:write']).admin.createCourse({ slug: 'x', title: 'x', priceChoice: 'free' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

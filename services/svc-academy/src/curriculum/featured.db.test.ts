/**
 * AC-articles-01 — the hub's featured slot holds only what staff chose, with a reason, and a visitor reads it signed out.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from '../academy-service.js';
import { createAcademyRouter } from '../router.js';
import { NullStreamProvider } from '../stream/provider.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzle, name), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const edge = createEdgeContext({ secret: 'an-academy-featured-test-edge-secret-long', serviceName: 'svc-academy' });

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

function service(): AcademyService {
  return new AcademyService(
    db.sql,
    {
      async stakeOf() {
        return 0n;
      },
    },
    {
      async perksOf() {
        throw new Error('host rights unused');
      },
    },
    new NullStreamProvider(),
    { tournamentEnabled: false, paperTradingEnabled: false },
  );
}

const visitor = (academy: AcademyService) =>
  createAcademyRouter(academy).createCaller(edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'anon' }));

describe('hub featured slot', () => {
  it('is empty until staff choose an item, then shows that item, and clears again', async () => {
    const academy = service();
    expect(await visitor(academy).publicHub()).toEqual({ featured: null, lesson: null });

    const chosen = await academy.setFeatured({ itemSlug: ' foundations-risk-first ', reason: 'Start here', operatorId: OPERATOR });
    expect(chosen).toMatchObject({ itemSlug: 'foundations-risk-first', reason: 'Start here' });
    const hub = await visitor(academy).publicHub();
    expect(hub.featured).toMatchObject({ slug: 'foundations-risk-first', path: 'foundations' });
    expect(Object.keys(hub.featured!)).not.toContain('body');

    await academy.setFeatured({ itemSlug: null, reason: 'Rotating', operatorId: OPERATOR });
    expect(await visitor(academy).publicHub()).toEqual({ featured: null, lesson: null });
    // A clear of an empty slot records nothing; every real feature and clear is a featured_events row with who and why.
    await academy.setFeatured({ itemSlug: null, reason: 'Again', operatorId: OPERATOR });
    const events = await db.sql<Array<{ action: string; item_slug: string | null; reason: string; actor: string }>>`
      SELECT action, item_slug, reason, actor FROM academy.featured_events ORDER BY at, action DESC
    `;
    expect(events.map((e) => ({ ...e }))).toEqual([
      { action: 'featured', item_slug: 'foundations-risk-first', reason: 'Start here', actor: OPERATOR },
      { action: 'cleared', item_slug: 'foundations-risk-first', reason: 'Rotating', actor: OPERATOR },
    ]);
  });

  it('refuses a blank reason and an unknown item, and writes nothing', async () => {
    const academy = service();
    await expect(academy.setFeatured({ itemSlug: 'foundations-risk-first', reason: '  ', operatorId: OPERATOR })).rejects.toMatchObject({
      code: 'academy.reason_required',
    });
    await expect(academy.setFeatured({ itemSlug: 'no-such-item', reason: 'x', operatorId: OPERATOR })).rejects.toMatchObject({
      code: 'academy.curriculum_not_found',
    });
    expect(await visitor(academy).publicHub()).toEqual({ featured: null, lesson: null });
    expect(await db.sql`SELECT 1 FROM academy.featured_events`).toHaveLength(0);
  });

  it('drops an item that has left the spine instead of showing it', async () => {
    await db.sql`INSERT INTO academy.featured_items (slot, item_slug, reason, chosen_by, chosen_at)
      VALUES ('hub', 'retired-item', 'old pick', ${OPERATOR}, now())`;
    expect(await visitor(service()).publicHub()).toEqual({ featured: null, lesson: null });
  });
});

describe('hub featured slot and release rules', () => {
  it('leaves out a chosen item a visitor could not open', async () => {
    const academy = service();
    await academy.setFeatured({ itemSlug: 'foundations-order-types', reason: 'Start here', operatorId: OPERATOR });
    await academy.setItemPrerequisites({ itemSlug: 'foundations-order-types', prerequisites: ['foundations-risk-first'] });
    expect(await visitor(academy).publicHub()).toEqual({ featured: null, lesson: null });
  });
});

describe('public course page and release rules', () => {
  it('drops the objectives of a lesson behind a prerequisite from the outcomes', async () => {
    const academy = service();
    const before = await visitor(academy).publicCourse({ slug: 'foundations' });
    await academy.setItemPrerequisites({ itemSlug: 'foundations-order-types', prerequisites: ['foundations-risk-first'] });
    const after = await visitor(academy).publicCourse({ slug: 'foundations' });
    expect(after.syllabus).toEqual(before.syllabus);
    expect(after.outcomes.length).toBeLessThan(before.outcomes.length);
  });
});

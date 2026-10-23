/**
 * AC-catalogue-01 — search follows stored enrolments, not the caller's word.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { AcademyService } from '../academy-service.js';
import { getCurriculumItem } from '../curriculum/catalog.js';
import { NullStreamProvider } from '../stream/provider.js';
import { createCatalogueRouter } from './router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzle, name), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const TEST_URL = adminUrl();
const available = await postgresAvailable(TEST_URL);
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'academy-catalogue-db-edge-secret-32';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

function signed(userId: string) {
  const principal = {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['academy:read', 'academy:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: `req-${userId}`,
  });
}

if (!available) {
  describe.skip('catalogue search on postgres', () => {
    it('unreachable', () => undefined);
  });
} else {
  describe('catalogue search on postgres', () => {
    let db: TestDatabase;
    let academy: AcademyService;

    beforeAll(async () => {
      db = await createTestDatabase({ service: 'academy', url: TEST_URL, migrations: MIGRATIONS });
      academy = new AcademyService(
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
    }, 30_000);

    afterAll(async () => {
      await db.drop();
    }, 30_000);

    beforeEach(async () => {
      await db.truncateAll();
    });

    function caller(userId: string) {
      return createCatalogueRouter({
        owner: { searchListLimit: 50, publicReadRate: { max: 20, windowSeconds: 60 } },
        enrolledPaths: async (id) => (await academy.myEnrollments(id)).map((row) => row.pathSlug),
        completedSlugs: (id) => academy.completedItemSlugs(id),
      }).createCaller(signed(userId));
    }

    it('returns foundations hits only for the enrolled account, and nothing for an account with no enrolment', async () => {
      await academy.enrollCertPath({ userId: USER, pathSlug: 'foundations' });
      const hits = await caller(USER).search({ q: 'invalidation level' });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => getCurriculumItem(hit.slug)?.path === 'foundations')).toBe(true);
      expect(hits.some((hit) => hit.offset !== null && hit.excerpt.toLowerCase().includes('invalidation level'))).toBe(true);
      const markets = await caller(USER).search({ q: 'Spread and slippage honesty' });
      expect(markets).toEqual([]);
      expect(await caller(OTHER).search({ q: 'invalidation level' })).toEqual([]);
      expect(await caller(USER).search({ q: 'invalidation level' })).toEqual(hits);
    });
  });
}

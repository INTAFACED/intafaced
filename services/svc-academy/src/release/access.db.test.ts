/**
 * Item release gates on the curriculum slugs the lesson screen already completes.
 * Figures are TEST times, not owner windows.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
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
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const FIRST = 'foundations-risk-first';
const SECOND = 'foundations-order-types';
const THIRD = 'foundations-fees-are-real';
const EDGE_SECRET = 'an-academy-release-test-edge-secret-long';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-academy' });

function learnerCaller(academy: AcademyService, userId: string = USER) {
  const principal = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['academy:read', 'academy:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  const ctx = edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-release',
  });
  return createAcademyRouter(academy).createCaller(ctx);
}

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

describe('item release access', () => {
  it('refuses completion until the prerequisite item is complete', async () => {
    const academy = service();
    await academy.setItemPrerequisites({ itemSlug: SECOND, prerequisites: [FIRST] });
    await expect(academy.markCurriculumComplete({ userId: USER, itemSlug: SECOND })).rejects.toMatchObject({
      code: 'academy.prerequisite_unmet',
    });
    await academy.markCurriculumComplete({ userId: USER, itemSlug: FIRST });
    const done = await academy.markCurriculumComplete({ userId: USER, itemSlug: SECOND });
    expect(done.itemSlug).toBe(SECOND);
    const view = await academy.itemRelease({ userId: USER, itemSlug: SECOND });
    expect(view.state).toBe('completed');
    expect(view).toMatchObject({
      availableFrom: null,
      availableUntil: null,
      dueAt: null,
      extendedUntil: null,
      reason: null,
      grantedAt: null,
      grantedBy: null,
    });
  });

  it('rolls back a prerequisite cycle and keeps the earlier edge', async () => {
    const academy = service();
    await academy.setItemPrerequisites({ itemSlug: SECOND, prerequisites: [FIRST] });
    await expect(academy.setItemPrerequisites({ itemSlug: FIRST, prerequisites: [SECOND] })).rejects.toMatchObject({
      code: 'academy.prerequisite_cycle',
    });
    const second = await academy.itemRelease({ userId: USER, itemSlug: SECOND });
    expect(second).toMatchObject({ lock: 'prerequisite', missing: [FIRST] });
    const first = await academy.itemRelease({ userId: USER, itemSlug: FIRST });
    expect(first.lock).toBeNull();
    expect(first.availableFrom).toBeNull();
    expect(first.availableUntil).toBeNull();
    expect(first.dueAt).toBeNull();
  });

  it('refuses an extension without a reason and does not store one', async () => {
    const academy = service();
    const now = new Date();
    const open = new Date(now.getTime() - 86_400_000);
    const shut = new Date(now.getTime() - 3_600_000);
    await academy.setItemWindow({ itemSlug: THIRD, availableFrom: open, availableUntil: shut, dueAt: null });
    await expect(
      academy.grantItemExtension({
        userId: USER,
        itemSlug: THIRD,
        reason: '   ',
        extendedUntil: new Date('2026-10-05T00:00:00.000Z'),
        clientRequestId: 'ext-blank',
        operatorId: OPERATOR,
      }),
    ).rejects.toMatchObject({ code: 'academy.reason_required' });
    const rows = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM academy.item_extensions WHERE user_id = ${USER}
    `;
    expect(rows[0]?.n).toBe(0);
  });

  it('locks a closed window, then one extension lets the same request complete once', async () => {
    const academy = service();
    const now = new Date();
    const open = new Date(now.getTime() - 86_400_000);
    const shut = new Date(now.getTime() - 3_600_000);
    await academy.setItemWindow({ itemSlug: THIRD, availableFrom: open, availableUntil: shut, dueAt: shut });
    await academy.setItemWindow({ itemSlug: SECOND, availableFrom: open, availableUntil: shut, dueAt: null });
    await expect(academy.markCurriculumComplete({ userId: USER, itemSlug: THIRD })).rejects.toMatchObject({
      code: 'academy.window_invalid',
    });
    const extendedUntil = new Date(now.getTime() + 86_400_000);
    const grant = {
      userId: USER,
      itemSlug: THIRD,
      reason: 'TEST late start',
      extendedUntil,
      clientRequestId: 'ext-1',
      operatorId: OPERATOR,
      now,
    };
    const first = await academy.grantItemExtension(grant);
    const again = await academy.grantItemExtension(grant);
    expect(again).toMatchObject({ revision: first.revision, reason: 'TEST late start', extendedUntil });
    await expect(
      academy.grantItemExtension({
        ...grant,
        reason: 'a different reason must not mint a second revision',
      }),
    ).rejects.toMatchObject({ code: 'academy.window_invalid' });
    await expect(
      academy.grantItemExtension({
        ...grant,
        extendedUntil: new Date(now.getTime() + 2 * 86_400_000),
      }),
    ).rejects.toMatchObject({ code: 'academy.window_invalid' });
    await expect(
      academy.grantItemExtension({
        ...grant,
        itemSlug: SECOND,
      }),
    ).rejects.toMatchObject({ code: 'academy.window_invalid' });
    const rows = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM academy.item_extensions WHERE user_id = ${USER}
    `;
    expect(rows[0]?.n).toBe(1);
    const view = await academy.itemRelease({ userId: USER, itemSlug: THIRD, now });
    expect(view).toMatchObject({
      state: 'unlocked',
      lock: null,
      availableFrom: open,
      availableUntil: shut,
      dueAt: shut,
      extendedUntil,
      reason: 'TEST late start',
      grantedBy: OPERATOR,
      grantedAt: now,
    });
    const other = await academy.itemRelease({ userId: OTHER, itemSlug: THIRD, now });
    expect(other).toMatchObject({
      state: 'locked',
      lock: 'window',
      availableFrom: open,
      availableUntil: shut,
      dueAt: shut,
      extendedUntil: null,
      reason: null,
      grantedAt: null,
      grantedBy: null,
    });
    const done = await academy.markCurriculumComplete({ userId: USER, itemSlug: THIRD });
    expect(done.itemSlug).toBe(THIRD);
  });

  it('sends no lesson body while locked, and sends it once the learner is open', async () => {
    const academy = service();
    await academy.setItemPrerequisites({ itemSlug: SECOND, prerequisites: [FIRST] });
    const caller = learnerCaller(academy);
    await expect(caller.curriculumItem({ slug: SECOND })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: `academy.prerequisite_unmet missing=${FIRST}`,
    });
    await expect(caller.curriculumItemLocalized({ slug: SECOND, locale: 'fr' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: `academy.prerequisite_unmet missing=${FIRST}`,
    });
    const open = await caller.curriculumItem({ slug: FIRST });
    expect(open.body).toContain('# Risk first');
    const localized = await caller.curriculumItemLocalized({ slug: FIRST, locale: 'fr' });
    expect(localized.body).toBe(open.body);
    expect(localized.fellBack).toBe(true);
    await caller.markCurriculumComplete({ itemSlug: FIRST });
    const unlocked = await caller.curriculumItem({ slug: SECOND });
    expect(unlocked.body).toContain('# Order types you will actually use');
    const unlockedLocalized = await caller.curriculumItemLocalized({ slug: SECOND, locale: 'en' });
    expect(unlockedLocalized.body).toBe(unlocked.body);

    const now = new Date('2026-10-10T00:00:00.000Z');
    await academy.setItemWindow({
      itemSlug: THIRD,
      availableFrom: new Date('2026-10-01T00:00:00.000Z'),
      availableUntil: new Date('2026-10-02T00:00:00.000Z'),
      dueAt: null,
    });
    await expect(caller.curriculumItem({ slug: THIRD })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'academy.window_invalid' },
    });
    await expect(caller.curriculumItemLocalized({ slug: THIRD, locale: 'fr' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'academy.window_invalid' },
    });
    await expect(academy.readCurriculumItem({ userId: USER, slug: THIRD, now })).rejects.toMatchObject({
      code: 'academy.window_invalid',
      message: 'academy.window_invalid outside the published window',
    });
    await expect(academy.readCurriculumItemLocalized({ userId: USER, slug: THIRD, locale: 'fr', now })).rejects.toMatchObject({
      code: 'academy.window_invalid',
    });
  });
});

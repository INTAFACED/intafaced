/**
 * Item release gates on the curriculum slugs the lesson screen already completes.
 * Figures are TEST times, not owner windows.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from '../academy-service.js';
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
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const FIRST = 'foundations-risk-first';
const SECOND = 'foundations-order-types';
const THIRD = 'foundations-fees-are-real';

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
    await expect(academy.markCurriculumComplete({ userId: USER, itemSlug: THIRD })).rejects.toMatchObject({
      code: 'academy.window_invalid',
    });
    const extendedUntil = new Date(now.getTime() + 86_400_000);
    const first = await academy.grantItemExtension({
      userId: USER,
      itemSlug: THIRD,
      reason: 'TEST late start',
      extendedUntil,
      clientRequestId: 'ext-1',
      operatorId: OPERATOR,
      now,
    });
    const again = await academy.grantItemExtension({
      userId: USER,
      itemSlug: THIRD,
      reason: 'a different reason must not mint a second revision',
      extendedUntil: new Date(now.getTime() + 2 * 86_400_000),
      clientRequestId: 'ext-1',
      operatorId: OPERATOR,
      now,
    });
    expect(again).toMatchObject({ revision: first.revision, reason: 'TEST late start', extendedUntil });
    const view = await academy.itemRelease({ userId: USER, itemSlug: THIRD, now });
    expect(view).toMatchObject({ state: 'unlocked', lock: null });
    const done = await academy.markCurriculumComplete({ userId: USER, itemSlug: THIRD });
    expect(done.itemSlug).toBe(THIRD);
  });
});

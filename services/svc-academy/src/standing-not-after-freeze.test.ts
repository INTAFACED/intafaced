/**
 * Seam: AcademyService.setStanding, read back through standings and freezeSnapshot.
 *
 * A standing write does not land once the season is frozen, and it does not
 * land after the freeze snapshot was taken. A score written while the season
 * is still live, before that snapshot, still lands. Standings are the rows
 * already stored.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from './academy-service.js';
import { AcademyError } from './errors.js';
import type { HostRightsSource } from './host-rights.js';
import type { StakeSource } from './stake-source.js';
import type { StreamProvider } from './stream/provider.js';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://Nitro@127.0.0.1:5432/intafaced_test';
const databaseName = new URL(TEST_URL).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_test')) {
  throw new Error(`Refusing to run standing-write tests against database ${databaseName}`);
}

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = ['0002_tournaments.sql', '0005_freeze_snapshot.sql'].map((name) =>
  readFileSync(join(here, '..', 'drizzle', name), 'utf8'),
);

const stakes: StakeSource = { stakeOf: async () => 0n };
const hostRights: HostRightsSource = {
  perksOf: async () => {
    throw new Error('standing write does not consult host rights');
  },
};
const stream: StreamProvider = {
  id: 'null',
  openRoom: async () => {
    throw new Error('standing write does not open a stream room');
  },
  credential: async () => {
    throw new Error('standing write does not mint a stream credential');
  },
  closeRoom: async () => {
    throw new Error('standing write does not close a stream room');
  },
};

/**
 * Freeze reads the board inside the season lock, then keeps that transaction
 * open. The standing write has to meet the lock before the snapshot commits.
 */
function sqlPausingAfterStandingsRead(sql: Sql, afterRead: () => Promise<void>): Sql {
  let armed = true;
  const wrap = (inner: Sql): Sql => {
    const invoke = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = (inner as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values);
      const text = strings.join(' ');
      const standingsRead =
        armed &&
        text.includes('FROM academy.tournament_standings') &&
        text.includes('SELECT') &&
        !text.includes('INSERT') &&
        !text.includes('UPDATE');
      if (!standingsRead) return query;
      armed = false;
      return query.then(async (rows) => {
        await afterRead();
        return rows;
      });
    };
    return new Proxy(invoke, {
      get(_target, property) {
        if (property === 'begin') {
          return (first: unknown, second?: unknown) => {
            if (typeof first === 'function') {
              return inner.begin(async (tx) => (first as (tx: Sql) => unknown)(wrap(tx as unknown as Sql)));
            }
            return inner.begin(first as string, async (tx) => (second as (tx: Sql) => unknown)(wrap(tx as unknown as Sql)));
          };
        }
        const value = Reflect.get(inner, property, inner) as unknown;
        if (typeof value === 'function') {
          return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(inner, args);
        }
        return value;
      },
    }) as unknown as Sql;
  };
  return wrap(sql);
}

function waitForLock(sql: Sql, timeoutMs: number, stop: { stop: boolean }): Promise<boolean> {
  const started = Date.now();
  const tick = async (): Promise<boolean> => {
    if (stop.stop) return false;
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
    `;
    if ((rows[0]?.n ?? 0) > 0) return true;
    if (stop.stop || Date.now() - started >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return tick();
  };
  return tick();
}

describe('standing write against a freeze snapshot', () => {
  let db: TestDatabase;
  let academy: AcademyService;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'academy', url: TEST_URL, migrations });
    academy = new AcademyService(db.sql, stakes, hostRights, stream, { tournamentEnabled: true });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
  });

  async function liveSeason(slug: string) {
    const season = await academy.createSeason({
      slug,
      title: 'Desk ladder',
      rulesSummary: 'Rank by score. No prizes.',
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: null,
    });
    return academy.setSeasonStatus({ seasonId: season.id, status: 'live' });
  }

  it('does not land a standing after the freeze has read the board', async () => {
    const season = await liveSeason('standing-after-snapshot');
    const alice = await academy.setStanding({ seasonId: season.id, userId: ALICE, score: 7 });
    const boardBefore = await academy.standings(season.id, { limit: 10 });

    let releaseSnapshot = () => {};
    const snapshotHeld = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let markStandingsRead = () => {};
    const standingsRead = new Promise<void>((resolve) => {
      markStandingsRead = resolve;
    });

    const freezer = new AcademyService(
      sqlPausingAfterStandingsRead(db.sql, async () => {
        markStandingsRead();
        await snapshotHeld;
      }),
      stakes,
      hostRights,
      stream,
      { tournamentEnabled: true },
    );

    const freezePromise = freezer.setSeasonStatus({ seasonId: season.id, status: 'frozen' });
    await standingsRead;

    const writePromise = academy.setStanding({ seasonId: season.id, userId: BOB, score: 99 });
    const stop = { stop: false };
    const sawBlock = await Promise.race([
      waitForLock(db.sql, 2_000, stop),
      writePromise.then(
        () => false,
        () => false,
      ),
    ]);
    stop.stop = true;
    releaseSnapshot();

    const frozen = await freezePromise;
    const writeError = await writePromise.then(
      () => null,
      (err: unknown) => err,
    );

    expect(sawBlock).toBe(true);
    expect(frozen.status).toBe('frozen');
    expect(await academy.freezeSnapshot(season.id)).toMatchObject({
      seasonId: season.id,
      standings: [{ rank: 1, userId: ALICE, score: 7, updatedAt: alice.updatedAt.toISOString() }],
    });
    expect(await academy.standings(season.id, { limit: 10 })).toEqual(boardBefore);
    expect(writeError).toBeInstanceOf(AcademyError);
    expect(writeError).toMatchObject({ code: 'academy.season_not_live' });
  });

  it('writes a score while the season is still live, before the freeze snapshot', async () => {
    const season = await liveSeason('score-before-snapshot');
    const alice = await academy.setStanding({ seasonId: season.id, userId: ALICE, score: 4 });

    expect(await academy.freezeSnapshot(season.id)).toBeNull();

    const frozen = await academy.setSeasonStatus({ seasonId: season.id, status: 'frozen' });

    expect(frozen.status).toBe('frozen');
    expect((await academy.freezeSnapshot(season.id))?.standings).toEqual([
      { rank: 1, userId: ALICE, score: 4, updatedAt: alice.updatedAt.toISOString() },
    ]);
    expect(await academy.standings(season.id, { limit: 10 })).toEqual([
      {
        rank: 1,
        seasonId: season.id,
        userId: ALICE,
        score: 4,
        updatedAt: alice.updatedAt,
      },
    ]);
  });

  it('does not land a standing once the season is frozen', async () => {
    const season = await liveSeason('frozen-refuses-standing');
    const alice = await academy.setStanding({ seasonId: season.id, userId: ALICE, score: 4 });
    await academy.setSeasonStatus({ seasonId: season.id, status: 'frozen' });
    const snapshot = await academy.freezeSnapshot(season.id);

    await expect(academy.setStanding({ seasonId: season.id, userId: BOB, score: 99 })).rejects.toMatchObject({
      code: 'academy.season_not_live',
    });

    expect(await academy.standings(season.id, { limit: 10 })).toEqual([
      {
        rank: 1,
        seasonId: season.id,
        userId: ALICE,
        score: 4,
        updatedAt: alice.updatedAt,
      },
    ]);
    expect(await academy.freezeSnapshot(season.id)).toEqual(snapshot);
  });
});

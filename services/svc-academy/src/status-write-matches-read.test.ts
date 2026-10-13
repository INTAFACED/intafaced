/**
 * Seam: AcademyService.setSeasonStatus for a non-freeze transition,
 * read back through season, freezeSnapshot, and standings.
 *
 * A non-freeze status write updates the row only when the stored status is
 * still the status that was read. A writer that read an older status does not
 * overwrite a concurrent freeze, and that freeze's snapshot stays on a season
 * that is still frozen. A transition from the status that is still stored
 * still writes. Standings are the rows already stored.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from './academy-service.js';
import type { HostRightsSource } from './host-rights.js';
import type { StakeSource } from './stake-source.js';
import type { StreamProvider } from './stream/provider.js';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://Nitro@127.0.0.1:5432/intafaced_test';
const databaseName = new URL(TEST_URL).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_test')) {
  throw new Error(`Refusing to run status-write tests against database ${databaseName}`);
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
    throw new Error('status write does not consult host rights');
  },
};
const stream: StreamProvider = {
  id: 'null',
  openRoom: async () => {
    throw new Error('status write does not open a stream room');
  },
  credential: async () => {
    throw new Error('status write does not mint a stream credential');
  },
  closeRoom: async () => {
    throw new Error('status write does not close a stream room');
  },
};

type SnapshotStanding = { rank: number; userId: string; score: number; updatedAt: string };

/**
 * The season read inside setSeasonStatus returns the row it saw. Before that
 * result is handed back, a freeze commits on the stored row.
 */
function sqlThatFreezesAfterSeasonRead(sql: Sql, freeze: () => Promise<void>): Sql {
  let armed = true;
  const invoke = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = (sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values);
    const text = strings.join(' ');
    const seasonRead = armed && text.includes('FROM academy.tournament_seasons') && text.includes('WHERE id') && !text.includes('UPDATE');
    if (!seasonRead) return query;
    return query.then(async (rows) => {
      armed = false;
      await freeze();
      return rows;
    });
  };
  return new Proxy(invoke, {
    get(_target, property) {
      const value = Reflect.get(sql, property, sql) as unknown;
      if (typeof value === 'function') {
        return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(sql, args);
      }
      return value;
    },
  }) as unknown as Sql;
}

describe('non-freeze season status write', () => {
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

  it('does not let a writer that read live overwrite a freeze that committed after that read', async () => {
    const season = await liveSeason('stale-read-versus-freeze');
    const alice = await academy.setStanding({ seasonId: season.id, userId: ALICE, score: 7 });
    const bob = await academy.setStanding({ seasonId: season.id, userId: BOB, score: 3 });
    const frozenAt = new Date('2026-10-07T03:00:00.000Z');
    const frozenStandings: SnapshotStanding[] = [
      { rank: 1, userId: ALICE, score: 7, updatedAt: alice.updatedAt.toISOString() },
      { rank: 2, userId: BOB, score: 3, updatedAt: bob.updatedAt.toISOString() },
    ];
    const boardBefore = await academy.standings(season.id, { limit: 10 });

    const writer = new AcademyService(
      sqlThatFreezesAfterSeasonRead(db.sql, async () => {
        const frozen = await db.sql<Array<{ status: string }>>`
          UPDATE academy.tournament_seasons
             SET status = 'frozen', updated_at = now()
           WHERE id = ${season.id}
             AND status = 'live'
          RETURNING status
        `;
        if (frozen.length !== 1) throw new Error('concurrent freeze did not commit');
        await db.sql`
          INSERT INTO academy.tournament_freeze_snapshots (season_id, frozen_at, standings)
          VALUES (${season.id}, ${frozenAt}, ${db.sql.json(frozenStandings)})
        `;
      }),
      stakes,
      hostRights,
      stream,
      { tournamentEnabled: true },
    );

    await writer.setSeasonStatus({ seasonId: season.id, status: 'ended' }).catch(() => undefined);

    const stored = await academy.season(season.id);
    const snapshot = await academy.freezeSnapshot(season.id);
    const boardAfter = await academy.standings(season.id, { limit: 10 });

    expect(snapshot).toEqual({
      seasonId: season.id,
      frozenAt,
      standings: frozenStandings,
    });
    expect(boardAfter).toEqual(boardBefore);
    expect(stored.status).toBe('frozen');
  });

  it('writes ended when the stored status is still live', async () => {
    const season = await liveSeason('live-end-while-live');
    const alice = await academy.setStanding({ seasonId: season.id, userId: ALICE, score: 4 });

    const ended = await academy.setSeasonStatus({ seasonId: season.id, status: 'ended' });

    expect(ended.status).toBe('ended');
    expect((await academy.season(season.id)).status).toBe('ended');
    expect(await academy.freezeSnapshot(season.id)).toBeNull();
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

  it('writes ended when the stored status is still frozen and keeps that freeze snapshot', async () => {
    const season = await liveSeason('frozen-end-while-frozen');
    const alice = await academy.setStanding({ seasonId: season.id, userId: ALICE, score: 9 });
    await academy.setSeasonStatus({ seasonId: season.id, status: 'frozen' });
    const snapshotBefore = await academy.freezeSnapshot(season.id);

    const ended = await academy.setSeasonStatus({ seasonId: season.id, status: 'ended' });

    expect(ended.status).toBe('ended');
    expect((await academy.season(season.id)).status).toBe('ended');
    expect(await academy.freezeSnapshot(season.id)).toEqual(snapshotBefore);
    expect(await academy.standings(season.id, { limit: 10 })).toEqual([
      {
        rank: 1,
        seasonId: season.id,
        userId: ALICE,
        score: 9,
        updatedAt: alice.updatedAt,
      },
    ]);
  });
});

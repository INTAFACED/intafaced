/**
 * Seam: AcademyService.setSeasonStatus (live → frozen) and freezeSnapshot.
 *
 * A snapshot row can already exist while the season is still live. Freezing
 * then must store the standings computed for this freeze and mark the season
 * frozen. A first freeze still writes its snapshot.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from './academy-service.js';
import type { HostRightsSource } from './host-rights.js';
import type { StakeSource } from './stake-source.js';
import type { StreamProvider } from './stream/provider.js';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://Nitro@127.0.0.1:5432/intafaced_test';
const databaseName = new URL(TEST_URL).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_test')) {
  throw new Error(`Refusing to run freeze snapshot tests against database ${databaseName}`);
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
    throw new Error('freeze does not consult host rights');
  },
};
const stream: StreamProvider = {
  id: 'null',
  openRoom: async () => {
    throw new Error('freeze does not open a stream room');
  },
  credential: async () => {
    throw new Error('freeze does not mint a stream credential');
  },
  closeRoom: async () => {
    throw new Error('freeze does not close a stream room');
  },
};

describe('season freeze standings snapshot', () => {
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

  it('writes the computed standings and freezes when no snapshot exists yet', async () => {
    const season = await liveSeason('first-freeze-board');
    const alice = await academy.setStanding({ seasonId: season.id, userId: ALICE, score: 7 });
    const bob = await academy.setStanding({ seasonId: season.id, userId: BOB, score: 3 });

    expect(await academy.freezeSnapshot(season.id)).toBeNull();

    const frozen = await academy.setSeasonStatus({ seasonId: season.id, status: 'frozen' });
    const snapshot = await academy.freezeSnapshot(season.id);

    expect(frozen.status).toBe('frozen');
    expect(snapshot?.standings).toEqual([
      { rank: 1, userId: ALICE, score: 7, updatedAt: alice.updatedAt.toISOString() },
      { rank: 2, userId: BOB, score: 3, updatedAt: bob.updatedAt.toISOString() },
    ]);
  });

  it('replaces an existing snapshot with the standings computed for this freeze', async () => {
    const season = await liveSeason('later-freeze-board');
    const earlyAlice = await academy.setStanding({ seasonId: season.id, userId: ALICE, score: 1 });
    const earlyBob = await academy.setStanding({ seasonId: season.id, userId: BOB, score: 2 });
    const earlierStandings = [
      { rank: 1, userId: BOB, score: 2, updatedAt: earlyBob.updatedAt.toISOString() },
      { rank: 2, userId: ALICE, score: 1, updatedAt: earlyAlice.updatedAt.toISOString() },
    ];
    await db.sql`
      INSERT INTO academy.tournament_freeze_snapshots (season_id, frozen_at, standings)
      VALUES (
        ${season.id},
        ${new Date('2020-01-01T00:00:00.000Z')},
        ${db.sql.json(earlierStandings)}
      )
    `;

    const laterAlice = await academy.setStanding({ seasonId: season.id, userId: ALICE, score: 10 });
    const laterBob = await academy.setStanding({ seasonId: season.id, userId: BOB, score: 40 });
    const earlier = await academy.freezeSnapshot(season.id);
    expect(earlier?.standings).toEqual(earlierStandings);

    const frozen = await academy.setSeasonStatus({ seasonId: season.id, status: 'frozen' });
    const snapshot = await academy.freezeSnapshot(season.id);

    expect(frozen.status).toBe('frozen');
    expect(snapshot?.standings).toEqual([
      { rank: 1, userId: BOB, score: 40, updatedAt: laterBob.updatedAt.toISOString() },
      { rank: 2, userId: ALICE, score: 10, updatedAt: laterAlice.updatedAt.toISOString() },
    ]);
  });
});

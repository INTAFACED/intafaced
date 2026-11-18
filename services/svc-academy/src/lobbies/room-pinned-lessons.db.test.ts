/**
 * A specialist room's pinned lessons (RC-academy-06; J-academy-19 #4).
 *
 * The host pins catalogue lessons to the room page; the page reads them back in the order pinned. Only the host pins or
 * unpins; a slug the catalogue does not have refuses; a repeat pin keeps its first place.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BASE_PERKS } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from '../academy-service.js';
import { NullStreamProvider } from '../stream/provider.js';
import { listCurriculum } from '../curriculum/catalog.js';

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
const HOST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const [FIRST, SECOND, THIRD] = listCurriculum().map((item) => item.slug);

afterAll(async () => {
  await db.drop();
}, 30_000);
beforeEach(async () => {
  await db.truncateAll();
});

const academy = new AcademyService(
  sql,
  { stakeOf: async () => 0n },
  { perksOf: async () => ({ ...BASE_PERKS, lobbyHostRights: true }) },
  new NullStreamProvider(),
  { tournamentEnabled: false, paperTradingEnabled: false, maxRoomCapacity: 100 },
);

const futuresRoom = () =>
  academy.createRoom({ hostId: HOST, slug: 'futures-desk', name: 'Futures desk', kind: 'futures', access: 'free', capacity: 20 });

describe('a specialist room page shows the lessons its host pinned', () => {
  it('reads the pins back in the order pinned, as the catalogue names them; a repeat pin keeps its place', async () => {
    const room = await futuresRoom();
    expect(await academy.pinnedLessons(room.id)).toEqual([]);
    await academy.pinLesson({ roomId: room.id, hostId: HOST, itemSlug: SECOND! });
    await academy.pinLesson({ roomId: room.id, hostId: HOST, itemSlug: FIRST! });
    await academy.pinLesson({ roomId: room.id, hostId: HOST, itemSlug: SECOND! });
    const pinned = await academy.pinnedLessons(room.id);
    expect(pinned.map((item) => item.slug)).toEqual([SECOND, FIRST]);
    expect(pinned[0]).toEqual(listCurriculum().find((item) => item.slug === SECOND));
  });

  it('only the host pins or unpins, and nothing changes on a refusal', async () => {
    const room = await futuresRoom();
    await academy.pinLesson({ roomId: room.id, hostId: HOST, itemSlug: FIRST! });
    await expect(academy.pinLesson({ roomId: room.id, hostId: OTHER, itemSlug: THIRD! })).rejects.toMatchObject({
      code: 'academy.not_host',
    });
    await expect(academy.unpinLesson({ roomId: room.id, hostId: OTHER, itemSlug: FIRST! })).rejects.toMatchObject({
      code: 'academy.not_host',
    });
    expect((await academy.pinnedLessons(room.id)).map((item) => item.slug)).toEqual([FIRST]);
  });

  it('refuses a lesson the catalogue does not have, and a room that does not exist', async () => {
    const room = await futuresRoom();
    await expect(academy.pinLesson({ roomId: room.id, hostId: HOST, itemSlug: 'no-such-lesson' })).rejects.toMatchObject({
      code: 'academy.curriculum_not_found',
    });
    await expect(
      academy.pinLesson({ roomId: '33333333-3333-4333-8333-333333333333', hostId: HOST, itemSlug: FIRST! }),
    ).rejects.toMatchObject({ code: 'academy.room_not_found' });
    expect(await sql`SELECT * FROM academy.room_pinned_lessons`).toEqual([]);
  });

  it('unpins one lesson and keeps the order of the rest; pins stay with their own room', async () => {
    const room = await futuresRoom();
    const clinic = await academy.createRoom({
      hostId: HOST,
      slug: 'merchant-clinic',
      name: 'Merchant clinic',
      kind: 'merchant_clinic',
      access: 'free',
      capacity: 20,
    });
    for (const itemSlug of [FIRST!, SECOND!, THIRD!]) await academy.pinLesson({ roomId: room.id, hostId: HOST, itemSlug });
    await academy.pinLesson({ roomId: clinic.id, hostId: HOST, itemSlug: THIRD! });
    await academy.unpinLesson({ roomId: room.id, hostId: HOST, itemSlug: SECOND! });
    await academy.unpinLesson({ roomId: room.id, hostId: HOST, itemSlug: SECOND! });
    expect((await academy.pinnedLessons(room.id)).map((item) => item.slug)).toEqual([FIRST, THIRD]);
    expect((await academy.pinnedLessons(clinic.id)).map((item) => item.slug)).toEqual([THIRD]);
    // A pin added after an unpin goes to the end.
    await academy.pinLesson({ roomId: room.id, hostId: HOST, itemSlug: SECOND! });
    expect((await academy.pinnedLessons(room.id)).map((item) => item.slug)).toEqual([FIRST, THIRD, SECOND]);
  });
});

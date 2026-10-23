import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from '../academy-service.js';
import { NullStreamProvider } from '../stream/provider.js';
import { listCurriculum } from '../curriculum/catalog.js';
import type { VideoSpineEntry } from './catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

/**
 * The shared test server's TEST_DATABASE_URL names database `test`.
 * createTestDatabase refuses any database whose name does not end in `_test`.
 * Same host, the existing `intafaced_test` database, when the env name is not already a test database.
 */
function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const ADMIN_URL = adminUrl();
const db: TestDatabase = await createTestDatabase({ service: 'academy', url: ADMIN_URL, migrations: MIGRATIONS });
const sql = db.sql;

const USER = '11111111-1111-4111-8111-111111111111';

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

function service(options: ConstructorParameters<typeof AcademyService>[4] = {}) {
  return new AcademyService(
    sql,
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
    { tournamentEnabled: false, paperTradingEnabled: false, ...options },
  );
}

const STAFF = '44444444-4444-4444-8444-444444444444';
const [FIRST, ITEM] = listCurriculum({ path: 'markets' }).map((row) => row.slug) as [string, string];
const SPINE: readonly VideoSpineEntry[] = [
  {
    slug: 'test-video',
    title: 'TEST video',
    path: 'markets',
    objectKey: 'test/video.webm',
    durationSeconds: null,
    thumbnailUrl: null,
    language: null,
    captionsUrl: null,
  },
];
const EN =
  'WEBVTT\n\nNOTE TEST captions\n\n1\n00:00.000 --> 00:02.500\nTEST: the first line\n\n00:02.500 --> 00:05.000 align:start\nTEST: the second line\n';
const ES = 'WEBVTT\n\n00:00.000 --> 00:05.000\nTEST: la primera línea\n';

let n = 0;
const save = (academy: AcademyService, positionSeconds: number) =>
  academy.setVideoProgress({ userId: USER, videoSlug: 'test-video', positionSeconds, clientRequestId: `video:test-video:${++n}` });
const attach = (academy: AcademyService, videoSlug: string | null = 'test-video') =>
  academy.setItemVideo({ itemSlug: ITEM, videoSlug, operatorId: STAFF, reason: 'TEST video item' });
const outlineRow = async (academy: AcademyService) => (await academy.courseOutline({ userId: USER, itemSlug: ITEM })).items[1]!;

describe('videos on items (AC-videos-01)', () => {
  it('lists caption tracks as cues in the order staff gave, refuses a bad file or a repeated language, and [] removes them', async () => {
    const academy = service({ videoSpine: SPINE });
    expect((await academy.videoPlayer('test-video')).tracks).toEqual([]);
    await academy.setVideoTracks({
      videoSlug: 'test-video',
      tracks: [
        { language: 'en', label: 'TEST English', vtt: EN },
        { language: 'es', label: 'TEST Español', vtt: ES },
      ],
      operatorId: STAFF,
      reason: 'TEST captions',
    });
    const player = await academy.videoPlayer('test-video');
    expect(player).toMatchObject({
      slug: 'test-video',
      renditions: [{ id: 'original' }],
      saveEverySeconds: null,
      watchThresholdSeconds: null,
    });
    expect(player.tracks.map((t) => [t.language, t.label, t.cues.length])).toEqual([
      ['en', 'TEST English', 2],
      ['es', 'TEST Español', 1],
    ]);
    expect(player.tracks[0]!.cues[1]).toEqual({ startMs: 2500, endMs: 5000, text: 'TEST: the second line' });

    const bad = (vtt: string) =>
      academy.setVideoTracks({ videoSlug: 'test-video', tracks: [{ language: 'en', label: 'x', vtt }], operatorId: STAFF, reason: 'TEST' });
    await expect(bad('00:00.000 --> 00:01.000\nno header')).rejects.toMatchObject({ code: 'academy.captions_invalid' });
    await expect(bad('WEBVTT\n\n00:02.000 --> 00:01.000\nbackwards')).rejects.toMatchObject({ code: 'academy.captions_invalid' });
    await expect(bad('WEBVTT\n\n00:00.000 --> 00:01.000\n')).rejects.toMatchObject({ code: 'academy.captions_invalid' });
    await expect(
      academy.setVideoTracks({
        videoSlug: 'test-video',
        tracks: [
          { language: 'en', label: 'a', vtt: EN },
          { language: 'en', label: 'b', vtt: EN },
        ],
        operatorId: STAFF,
        reason: 'TEST',
      }),
    ).rejects.toMatchObject({ code: 'academy.captions_invalid' });
    expect((await academy.videoPlayer('test-video')).tracks).toHaveLength(2);
    await expect(academy.setVideoTracks({ videoSlug: 'nope', tracks: [], operatorId: STAFF, reason: 'TEST' })).rejects.toMatchObject({
      code: 'academy.video_not_found',
    });
    await academy.setVideoTracks({ videoSlug: 'test-video', tracks: [], operatorId: STAFF, reason: 'TEST off' });
    expect((await academy.videoPlayer('test-video')).tracks).toEqual([]);
  });

  it('an item with a video completes by watching past the threshold, without a button, once', async () => {
    const academy = service({ videoSpine: SPINE, videoWatchThresholdSeconds: 4, videoSaveEverySeconds: 2 });
    expect(await academy.itemVideo(ITEM)).toEqual({ itemSlug: ITEM, videoSlug: null });
    await attach(academy);
    expect(await academy.itemVideo(ITEM)).toEqual({ itemSlug: ITEM, videoSlug: 'test-video' });
    expect(await outlineRow(academy)).toMatchObject({ rule: 'watch', ruleMet: false, completedAt: null });
    await expect(academy.markCurriculumComplete({ userId: USER, itemSlug: ITEM })).rejects.toMatchObject({
      code: 'academy.completion_rule_unmet',
    });

    expect(await save(academy, 3)).toEqual({ videoSlug: 'test-video', positionSeconds: 3, completedItems: [] });
    expect((await outlineRow(academy)).completedAt).toBeNull();
    expect(await save(academy, 4)).toEqual({ videoSlug: 'test-video', positionSeconds: 4, completedItems: [ITEM] });
    expect(await outlineRow(academy)).toMatchObject({ rule: 'watch', ruleMet: true, completedAt: expect.any(String) });
    expect(await save(academy, 6)).toMatchObject({ completedItems: [] });
    const events = await sql`SELECT event FROM academy.item_completion_events WHERE user_id = ${USER} AND item_slug = ${ITEM}`;
    expect(events.map((row) => row.event)).toEqual(['completed']);
    // The pressed button agrees once watched: the item is already complete.
    expect((await academy.markCurriculumComplete({ userId: USER, itemSlug: ITEM })).itemSlug).toBe(ITEM);

    // Taking the video off returns the item to the view rule.
    await attach(academy, null);
    expect(await outlineRow(academy)).toMatchObject({ rule: 'view', ruleMet: true });
    await expect(attach(academy, 'nope')).rejects.toMatchObject({ code: 'academy.video_not_found' });
    await expect(
      academy.setItemVideo({ itemSlug: 'nope', videoSlug: 'test-video', operatorId: STAFF, reason: 'TEST' }),
    ).rejects.toMatchObject({
      code: 'academy.curriculum_not_found',
    });
  });

  it('a locked item keeps the watch position and completes on a later save once it opens; a blank threshold completes nothing', async () => {
    const academy = service({ videoSpine: SPINE, videoWatchThresholdSeconds: 4 });
    await attach(academy);
    await academy.setItemPrerequisites({ itemSlug: ITEM, prerequisites: [FIRST] });
    expect(await save(academy, 10)).toMatchObject({ positionSeconds: 10, completedItems: [] });
    await academy.markCurriculumComplete({ userId: USER, itemSlug: FIRST });
    expect(await save(academy, 11)).toMatchObject({ completedItems: [ITEM] });

    const unset = service({ videoSpine: SPINE });
    await academy.undoCurriculumComplete({
      userId: USER,
      itemSlug: ITEM,
      completedAt: (await outlineRow(academy)).completedAt!,
      clientRequestId: 'undo:test',
    });
    expect(await save(unset, 12)).toMatchObject({ completedItems: [] });
    await expect(unset.markCurriculumComplete({ userId: USER, itemSlug: ITEM })).rejects.toMatchObject({
      code: 'academy.watch_threshold_unset',
    });
    expect((await unset.courseOutline({ userId: USER, itemSlug: ITEM })).items[1]).toMatchObject({ rule: 'watch', ruleMet: false });
  });
});

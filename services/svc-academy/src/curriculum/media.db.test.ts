/**
 * AC-videos-02 — a course item's video, captions and handouts: owner limits, signed upload, read-back check of size
 * and leading bytes, and SRT / WebVTT captions checked line by line.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';
import { CourseMedia, type ReadBackFn, type UploadLimits } from './media.js';

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
const A = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const STORAGE = {
  endpoint: 'http://127.0.0.1:9',
  bucket: 'academy-test',
  accessKey: 'dev-only-key',
  secretKey: 'dev-only-secret',
  region: 'test-1',
  ttlSeconds: 300,
};
const LIMITS: UploadLimits = { maxBytes: 1000, videoTypes: ['video/webm'], handoutTypes: ['application/pdf', 'image/png'] };
const WEBM = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];
const SHA = (c: string) => c.repeat(64);

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

/**
 * A store that holds what the test says, and records every read. An object's SHA-256 is the one its key was issued for
 * (the stored bytes are the declared file) unless the test says otherwise.
 */
function store(objects: Record<string, { total: number; head: number[]; sha256?: string }>) {
  const reads: string[] = [];
  const readBack: ReadBackFn = async (url) => {
    reads.push(url);
    const key = Object.keys(objects).find((k) => new URL(url).pathname.endsWith(k));
    if (!key) return { status: 404, bytes: 0, head: new Uint8Array(), sha256: '' };
    const o = objects[key]!;
    return { status: 200, bytes: o.total, head: Uint8Array.from(o.head), sha256: o.sha256 ?? key.split('/').pop()! };
  };
  return { readBack, reads };
}

const media = (limits: UploadLimits, readBack?: ReadBackFn) => new CourseMedia(db.sql, STORAGE, limits, readBack);

async function lessonItem() {
  const courses = new CourseRecords(db.sql, { maxSections: 5, maxItems: 5 });
  const course = await courses.create({
    slug: 'risk-basics',
    title: 'Risk basics',
    summary: null,
    thumbnailUrl: null,
    pricing: 'free',
    price: null,
    priceAsset: null,
    operatorId: A,
    now: NOW,
  });
  const detail = await courses.saveOutline({
    courseId: course.id,
    revision: 1,
    sections: [
      {
        title: 'Start here',
        items: [
          { kind: 'video', title: 'Sizing a position', indent: 0, url: null },
          { kind: 'subheader', title: 'Part 1', indent: 0, url: null },
        ],
      },
    ],
    operatorId: A,
    now: NOW,
  });
  const [video, subheader] = detail.outline[0]!.items;
  return { courseId: course.id, item: video!, subheader: subheader! };
}

const declare = (
  itemId: string,
  over: Partial<{ kind: 'video' | 'handout'; contentType: string; bytes: number; sha256: string; fileName: string }> = {},
) => ({
  itemId,
  kind: 'video' as const,
  fileName: 'sizing.webm',
  contentType: 'video/webm',
  bytes: 800,
  sha256: SHA('a'),
  operatorId: A,
  now: NOW,
  ...over,
});

describe('course uploads (AC-videos-02)', () => {
  it('blank owner limits refuse by name, and the item still reads with the limits shown as not set', async () => {
    const { item } = await lessonItem();
    for (const limits of [
      { maxBytes: null, videoTypes: ['video/webm'], handoutTypes: ['application/pdf'] },
      { maxBytes: 1000, videoTypes: null, handoutTypes: ['application/pdf'] },
    ])
      await expect(media(limits).intent(declare(item.id))).rejects.toMatchObject({ code: 'academy.upload_limits_unset' });
    await expect(
      media({ maxBytes: 1000, videoTypes: ['video/webm'], handoutTypes: null }).intent(
        declare(item.id, { kind: 'handout', contentType: 'application/pdf' }),
      ),
    ).rejects.toMatchObject({ code: 'academy.upload_limits_unset' });
    const read = await media({ maxBytes: null, videoTypes: null, handoutTypes: null }).itemMedia(item.id, NOW);
    expect(read).toEqual({
      itemId: item.id,
      videoId: null,
      limits: { maxBytes: null, videoTypes: null, handoutTypes: null },
      media: [],
      captions: [],
    });
  });

  it('over the size or of a type not accepted refuses before any row or address; a subheader holds no files', async () => {
    const { item, subheader } = await lessonItem();
    await expect(media(LIMITS).intent(declare(item.id, { bytes: 1001 }))).rejects.toMatchObject({ code: 'academy.upload_too_large' });
    await expect(media(LIMITS).intent(declare(item.id, { contentType: 'video/mp4' }))).rejects.toMatchObject({
      code: 'academy.upload_type_refused',
    });
    // An accepted type whose content svc-academy cannot check is never taken.
    await expect(
      media({ ...LIMITS, handoutTypes: ['text/plain'] }).intent(declare(item.id, { kind: 'handout', contentType: 'text/plain' })),
    ).rejects.toMatchObject({ code: 'academy.upload_type_refused' });
    await expect(media(LIMITS).intent(declare(subheader.id))).rejects.toMatchObject({ code: 'academy.item_has_no_lesson' });
    const [count] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM academy.course_media`;
    expect(count?.n).toBe(0);
  });

  it('an intent issues a signed PUT; the same file resumes its row; confirm checks size and leading bytes', async () => {
    const { courseId, item } = await lessonItem();
    const key = `courses/${courseId}/items/${item.id}/video/${SHA('a')}`;
    const first = await media(LIMITS).intent(declare(item.id));
    expect(first.media).toMatchObject({ state: 'pending', bytes: 800, url: null });
    expect(new URL(first.uploadUrl!).pathname).toBe(`/academy-test/${key}`);
    expect(first.uploadUrl).toContain('X-Amz-Signature=');
    const again = await media(LIMITS).intent(declare(item.id, { fileName: 'renamed.webm' }));
    expect(again.media.id).toBe(first.media.id);
    expect(again.media.fileName).toBe('renamed.webm');

    // Nothing stored yet: the row stays pending.
    const empty = store({});
    await expect(media(LIMITS, empty.readBack).confirm({ mediaId: first.media.id, operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.upload_incomplete',
    });
    // A partial object: still pending.
    const partial = store({ [key]: { total: 400, head: WEBM } });
    await expect(media(LIMITS, partial.readBack).confirm({ mediaId: first.media.id, operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.upload_incomplete',
    });

    // The declared size, but not the declared file: still pending.
    const other = store({ [key]: { total: 800, head: WEBM, sha256: SHA('f') } });
    await expect(media(LIMITS, other.readBack).confirm({ mediaId: first.media.id, operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.upload_incomplete',
      message: 'the stored bytes are not the file that was declared; send it again',
    });

    const whole = store({ [key]: { total: 800, head: WEBM } });
    const ready = await media(LIMITS, whole.readBack).confirm({ mediaId: first.media.id, operatorId: A, now: NOW });
    expect(ready).toMatchObject({ state: 'ready', refusal: null });
    expect(ready.url).toContain(key);
    // A confirmed file answers again without a read, and a new intent for it needs no upload.
    expect(await media(LIMITS, whole.readBack).confirm({ mediaId: first.media.id, operatorId: A, now: NOW })).toMatchObject({
      state: 'ready',
    });
    expect(whole.reads).toHaveLength(1);
    expect((await media(LIMITS).intent(declare(item.id))).uploadUrl).toBeNull();
    await expect(media(LIMITS).confirm({ mediaId: '99999999-9999-4999-8999-999999999999', operatorId: A, now: NOW })).rejects.toMatchObject(
      {
        code: 'academy.media_not_found',
      },
    );
  });

  it('a handout declared PDF whose bytes are PNG is refused with its reason, and never given an address', async () => {
    const { courseId, item } = await lessonItem();
    const handout = declare(item.id, {
      kind: 'handout',
      contentType: 'application/pdf',
      fileName: 'sheet.pdf',
      bytes: 300,
      sha256: SHA('b'),
    });
    const { media: row } = await media(LIMITS).intent(handout);
    const key = `courses/${courseId}/items/${item.id}/handout/${SHA('b')}`;
    const png = store({ [key]: { total: 300, head: PNG } });
    await expect(media(LIMITS, png.readBack).confirm({ mediaId: row.id, operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.file_type_mismatch',
      message: 'the file was declared application/pdf but its content is image/png',
    });
    const read = await media(LIMITS).itemMedia(item.id, NOW);
    expect(read.media).toEqual([
      expect.objectContaining({ id: row.id, state: 'refused', url: null, refusal: expect.stringContaining('image/png') }),
    ]);
    // The same bytes declared as what they are are checked again.
    const redeclared = await media(LIMITS).intent({ ...handout, contentType: 'image/png', fileName: 'sheet.png' });
    expect(redeclared.media).toMatchObject({ id: row.id, state: 'pending', refusal: null });
    expect(await media(LIMITS, png.readBack).confirm({ mediaId: row.id, operatorId: A, now: NOW })).toMatchObject({ state: 'ready' });
    const pdfKey = `courses/${courseId}/items/${item.id}/handout/${SHA('c')}`;
    const { media: pdf } = await media(LIMITS).intent({ ...handout, sha256: SHA('c') });
    expect(
      await media(LIMITS, store({ [pdfKey]: { total: 300, head: PDF } }).readBack).confirm({ mediaId: pdf.id, operatorId: A, now: NOW }),
    ).toMatchObject({
      state: 'ready',
    });
  });

  it('captions need a ready video; a malformed SRT line is returned and nothing stored; a good file is stored per language', async () => {
    const { courseId, item } = await lessonItem();
    const captions = { itemId: item.id, language: 'en', label: 'English', format: 'srt' as const, operatorId: A, now: NOW };
    const good = '1\n00:00:01,000 --> 00:00:04,000\nSize the position first.\n\n2\n00:00:05,000 --> 00:00:07,500\nThen the stop.\n';
    await expect(media(LIMITS).setCaptions({ ...captions, text: good })).rejects.toMatchObject({ code: 'academy.item_video_missing' });
    const { media: video } = await media(LIMITS).intent(declare(item.id));
    const key = `courses/${courseId}/items/${item.id}/video/${SHA('a')}`;
    await media(LIMITS, store({ [key]: { total: 800, head: WEBM } }).readBack).confirm({ mediaId: video.id, operatorId: A, now: NOW });

    const bad = '1\n00:00:01,000 --> 00:00:04,000\nSize the position first.\n\n2\n00:00:05.000 --> 00:00:07,500\nThen the stop.\n';
    const refused = await media(LIMITS).setCaptions({ ...captions, text: bad });
    expect(refused).toMatchObject({ outcome: 'invalid', problem: 'line 6: "00:00:05.000" is not an SRT timestamp' });
    expect(refused.media.captions).toEqual([]);

    const saved = await media(LIMITS).setCaptions({ ...captions, text: good });
    expect(saved).toMatchObject({ outcome: 'saved' });
    expect(saved.media.captions).toEqual([
      { language: 'en', label: 'English', format: 'srt', cues: 2, firstCue: 'Size the position first.' },
    ]);
    const vtt = await media(LIMITS).setCaptions({
      ...captions,
      language: 'de',
      label: 'Deutsch',
      format: 'vtt',
      text: 'WEBVTT\n\n00:01.000 --> 00:02.000\nHallo\n',
    });
    expect(vtt.media.captions.map((c) => c.language)).toEqual(['de', 'en']);
    expect(vtt.media.videoId).toBe(video.id);

    // A re-cut video becomes the item's video and starts with none of the old timings.
    const { media: recut } = await media(LIMITS).intent(declare(item.id, { sha256: SHA('d'), fileName: 'recut.webm' }));
    const recutKey = `courses/${courseId}/items/${item.id}/video/${SHA('d')}`;
    await media(LIMITS, store({ [recutKey]: { total: 800, head: WEBM } }).readBack).confirm({
      mediaId: recut.id,
      operatorId: A,
      now: new Date(NOW.getTime() + 60_000),
    });
    const after = await media(LIMITS).itemMedia(item.id, NOW);
    expect(after.videoId).toBe(recut.id);
    expect(after.captions).toEqual([]);
  });
});

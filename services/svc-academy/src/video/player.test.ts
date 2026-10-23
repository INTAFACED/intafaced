/**
 * AC-videos-01 — captions, transcript, and the watch threshold.
 * Fixture text and URLs are TEST data. The shipped spine stays unpublished.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { AcademyService } from '../academy-service.js';
import { createAcademyRouter } from '../router.js';
import type { VideoSpineEntry } from './catalog.js';
import {
  decideWatched,
  readVideoCaptions,
  readVideoTranscript,
  requireWatchThresholdSeconds,
  VIDEO_TRANSCRIPTS,
  type PublishedTranscript,
} from './player.js';

const SLUG = 'foundations-risk-first';
const SECRET = 'an-academy-video-player-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';

const TEST_SPINE: readonly VideoSpineEntry[] = [
  {
    slug: SLUG,
    title: 'Risk first',
    path: 'foundations',
    objectKey: 'foundations/risk-first.mp4',
    durationSeconds: 30,
    thumbnailUrl: null,
    language: 'en',
    captionsUrl: 'https://example.test/captions.vtt',
  },
];

const TEST_TRANSCRIPTS: Readonly<Record<string, PublishedTranscript>> = {
  [SLUG]: { language: 'en', text: 'TEST transcript. Not owner content.' },
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? '';
  }
  return '';
}

describe('video player tracks (AC-videos-01)', () => {
  it('the shipped spine publishes neither a captions URL nor a transcript', () => {
    expect(codeOf(() => readVideoCaptions(SLUG))).toBe('academy.video_captions_unpublished');
    expect(codeOf(() => readVideoTranscript(SLUG))).toBe('academy.video_transcript_unpublished');
    expect(VIDEO_TRANSCRIPTS).toEqual({});
  });

  it('an unknown slug is not found, and a blank track is unpublished', () => {
    expect(codeOf(() => readVideoCaptions('not-a-video'))).toBe('academy.video_not_found');
    expect(codeOf(() => readVideoTranscript('not-a-video', TEST_TRANSCRIPTS))).toBe('academy.video_not_found');
    expect(codeOf(() => readVideoTranscript(SLUG, { [SLUG]: { language: ' ', text: 'TEST' } }, TEST_SPINE))).toBe(
      'academy.video_transcript_unpublished',
    );
    expect(codeOf(() => readVideoCaptions(SLUG, [{ ...TEST_SPINE[0]!, captionsUrl: '  ' }]))).toBe('academy.video_captions_unpublished');
  });

  it('a published TEST track is returned as stored, with no invented language', () => {
    expect(readVideoCaptions(SLUG, TEST_SPINE)).toEqual({
      slug: SLUG,
      captionsUrl: 'https://example.test/captions.vtt',
      language: 'en',
    });
    expect(readVideoCaptions(SLUG, [{ ...TEST_SPINE[0]!, language: null }])).toEqual({
      slug: SLUG,
      captionsUrl: 'https://example.test/captions.vtt',
      language: null,
    });
    expect(readVideoTranscript(SLUG, TEST_TRANSCRIPTS, TEST_SPINE).text).toBe('TEST transcript. Not owner content.');
  });

  it('a blank watch threshold refuses, including zero and a fraction', () => {
    expect(codeOf(() => requireWatchThresholdSeconds(undefined))).toBe('academy.watch_threshold_unset');
    expect(codeOf(() => requireWatchThresholdSeconds(0))).toBe('academy.watch_threshold_unset');
    expect(codeOf(() => requireWatchThresholdSeconds(1.5))).toBe('academy.watch_threshold_unset');
  });

  it('watched uses the stored position and does not lower the threshold to the duration', () => {
    expect(decideWatched({ videoSlug: SLUG, positionSeconds: null, thresholdSeconds: 15 })).toEqual({
      videoSlug: SLUG,
      positionSeconds: null,
      thresholdSeconds: 15,
      watched: false,
    });
    expect(decideWatched({ videoSlug: SLUG, positionSeconds: 15, thresholdSeconds: 15 }).watched).toBe(true);
    expect(decideWatched({ videoSlug: SLUG, positionSeconds: 30, thresholdSeconds: 40 })).toEqual({
      videoSlug: SLUG,
      positionSeconds: 30,
      thresholdSeconds: 40,
      watched: false,
    });
  });
});

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

function signed(userId: string) {
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
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: `req-${userId}`,
  });
}

describe('video player doors (AC-videos-01)', () => {
  it('captions and transcript refuse on the shipped recording', async () => {
    const caller = createAcademyRouter({} as AcademyService).createCaller(signed(USER));
    await expect(caller.videoCaptions({ slug: SLUG })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'academy.video_storage_unconfigured' },
    });
    await expect(caller.videoTranscript({ slug: SLUG })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'academy.video_storage_unconfigured' },
    });
    await expect(caller.videoCaptions({ slug: 'missing' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'academy.video_storage_unconfigured' },
    });
  });

  it('watched refuses a blank threshold and only reads the caller', async () => {
    const getVideoProgress = vi.fn(async ({ userId, videoSlug }: { userId: string; videoSlug: string }) => ({
      videoSlug,
      positionSeconds: userId === USER ? 20 : 1,
    }));
    const academy = { getVideoProgress } as unknown as AcademyService;
    const blank = createAcademyRouter(academy).createCaller(signed(USER));
    await expect(blank.videoProgress.watched({ videoSlug: SLUG })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'academy.watch_threshold_unset' },
    });

    const router = createAcademyRouter(academy, {}, undefined, undefined, null, {
      ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS: 15,
    });
    const mine = await router.createCaller(signed(USER)).videoProgress.watched({ videoSlug: SLUG });
    const theirs = await router.createCaller(signed(OTHER)).videoProgress.watched({ videoSlug: SLUG });
    expect(mine).toEqual({ videoSlug: SLUG, positionSeconds: 20, thresholdSeconds: 15, watched: true });
    expect(theirs).toEqual({ videoSlug: SLUG, positionSeconds: 1, thresholdSeconds: 15, watched: false });
    expect(getVideoProgress).toHaveBeenCalledWith({ userId: USER, videoSlug: SLUG });
    expect(getVideoProgress).toHaveBeenCalledWith({ userId: OTHER, videoSlug: SLUG });
  });
});

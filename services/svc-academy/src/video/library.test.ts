import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { AcademyError } from '../errors.js';
import {
  assertAcademyVideoUrlGranted,
  grantAcademyVideoCaptions,
  grantAcademyVideoPlayback,
  grantAcademyVideoTranscript,
  listAcademyVideos,
  unconfiguredVideoLibrary,
  type VideoLibraryDeps,
} from './library.js';
import { type VideoStorageConfig } from './storage.js';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const USER = '11111111-1111-4111-8111-111111111111';

const storage: VideoStorageConfig = {
  endpoint: 'http://academy-minio:9000',
  bucket: 'academy-video',
  accessKey: 'academyvideo',
  secretKey: 'academyvideo-secret-key',
  region: 'us-east-1',
  ttlSeconds: 300,
};

function deps(over: Partial<VideoLibraryDeps> = {}): VideoLibraryDeps {
  return {
    storage,
    gate: { minTier: 'none', minStake: '0' },
    stakeOf: async () => parseAmount('1'),
    now: () => NOW,
    ...over,
  };
}

describe('academy stored video — unconfigured refuse', () => {
  it('list refuses academy.video_storage_unconfigured when storage is off', () => {
    try {
      listAcademyVideos(unconfiguredVideoLibrary());
      throw new Error('expected refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(AcademyError);
      expect((err as AcademyError).code).toBe('academy.video_storage_unconfigured');
    }
  });

  it('blank endpoint is unconfigured, not a public bucket', () => {
    try {
      listAcademyVideos(deps({ storage: { ...storage, endpoint: '' } }));
      throw new Error('expected refuse');
    } catch (err) {
      expect((err as AcademyError).code).toBe('academy.video_storage_unconfigured');
    }
  });
});

describe('academy stored video — grant and signed URL', () => {
  it('configured list returns the named spine and never a playback URL', () => {
    const items = listAcademyVideos(deps());
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]?.slug).toBe('foundations-risk-first');
    expect(items[0]?.captionsPublished).toBe(false);
    expect(items[0]?.transcriptPublished).toBe(false);
    expect(items[0]?.captionsUrl).toBeNull();
    expect(JSON.stringify(items)).not.toMatch(/X-Amz-Signature/);
  });

  it('playback issues a signed expiring URL after tier/stake gate', async () => {
    const play = await grantAcademyVideoPlayback({
      deps: deps(),
      slug: 'foundations-risk-first',
      caller: { userId: USER, tier: 'none' },
    });
    expect(play.playbackUrl).toContain('X-Amz-Signature=');
    expect(play.playbackUrl).toContain('X-Amz-Expires=300');
    expect(play.expiresAt.toISOString()).toBe('2026-08-23T12:05:00.000Z');
    expect(play.grant.startsWith('v1.')).toBe(true);
    assertAcademyVideoUrlGranted(deps(), play.playbackUrl, NOW);
    try {
      assertAcademyVideoUrlGranted(deps(), play.playbackUrl, new Date(NOW.getTime() + 301_000));
      throw new Error('expected expire refuse');
    } catch (err) {
      expect((err as AcademyError).code).toBe('academy.video_grant_required');
    }
  });

  it('URL without grant fails by name', () => {
    try {
      assertAcademyVideoUrlGranted(deps(), 'http://academy-minio:9000/academy-video/foundations/risk-first.mp4', NOW);
      throw new Error('expected refuse');
    } catch (err) {
      expect((err as AcademyError).code).toBe('academy.video_grant_required');
    }
  });

  it('captions and transcript use the playback gate and return a signed URL', async () => {
    const spine = [
      {
        slug: 'foundations-risk-first',
        title: 'Risk first',
        path: 'foundations' as const,
        objectKey: 'foundations/risk-first.mp4',
        durationSeconds: 30,
        thumbnailUrl: null,
        language: 'en',
        captionsUrl: 'captions/risk-first.vtt',
      },
    ];
    const caller = { userId: USER, tier: 'none' as const };
    await expect(
      grantAcademyVideoCaptions({
        deps: deps({ gate: { minTier: '', minStake: '' } }),
        slug: 'foundations-risk-first',
        caller,
        spine,
      }),
    ).rejects.toMatchObject({ code: 'academy.video_grant_required' });
    const captions = await grantAcademyVideoCaptions({
      deps: deps(),
      slug: 'foundations-risk-first',
      caller,
      spine,
    });
    expect(captions.captionsUrl).toContain('X-Amz-Signature=');
    expect(captions.captionsUrl).not.toBe('captions/risk-first.vtt');
    expect(captions.grant.startsWith('v1.')).toBe(true);
    const transcript = await grantAcademyVideoTranscript({
      deps: deps(),
      slug: 'foundations-risk-first',
      caller,
      spine,
      transcripts: { 'foundations-risk-first': { language: 'en', text: 'TEST transcript.' } },
    });
    expect(transcript.transcriptUrl).toContain('X-Amz-Signature=');
    expect(transcript.text).toBe('TEST transcript.');
  });

  it('unknown slug is not a grant', async () => {
    await expect(
      grantAcademyVideoPlayback({
        deps: deps(),
        slug: 'not-a-video',
        caller: { userId: USER, tier: 'none' },
      }),
    ).rejects.toMatchObject({ code: 'academy.video_grant_required' });
  });

  it('blank owner magnitudes refuse closed — no invented stake or tier', async () => {
    await expect(
      grantAcademyVideoPlayback({
        deps: deps({ gate: { minTier: '', minStake: '' } }),
        slug: 'foundations-risk-first',
        caller: { userId: USER, tier: 'none' },
      }),
    ).rejects.toMatchObject({ code: 'academy.video_grant_required' });
  });

  it('a caller below a published gate is refused captions and transcript', async () => {
    const spine = [
      {
        slug: 'foundations-risk-first',
        title: 'Risk first',
        path: 'foundations' as const,
        objectKey: 'foundations/risk-first.mp4',
        durationSeconds: 30,
        thumbnailUrl: null,
        language: 'en',
        captionsUrl: 'captions/risk-first.vtt',
      },
    ];
    const caller = { userId: USER, tier: 'none' as const };
    const gate = { minTier: 'full', minStake: '0' };
    await expect(
      grantAcademyVideoCaptions({
        deps: deps({ gate }),
        slug: 'foundations-risk-first',
        caller,
        spine,
      }),
    ).rejects.toMatchObject({ code: 'academy.video_grant_required' });
    await expect(
      grantAcademyVideoTranscript({
        deps: deps({ gate }),
        slug: 'foundations-risk-first',
        caller,
        spine,
        transcripts: { 'foundations-risk-first': { language: 'en', text: 'TEST transcript.' } },
      }),
    ).rejects.toMatchObject({ code: 'academy.video_grant_required' });
  });

  it('a basic caller below a published full gate is refused captions and transcript', async () => {
    const spine = [
      {
        slug: 'foundations-risk-first',
        title: 'Risk first',
        path: 'foundations' as const,
        objectKey: 'foundations/risk-first.mp4',
        durationSeconds: 30,
        thumbnailUrl: null,
        language: 'en',
        captionsUrl: 'captions/risk-first.vtt',
      },
    ];
    const caller = { userId: USER, tier: 'basic' as const };
    const gate = { minTier: 'full', minStake: '0' };
    await expect(grantAcademyVideoCaptions({ deps: deps({ gate }), slug: 'foundations-risk-first', caller, spine })).rejects.toMatchObject({
      code: 'academy.video_grant_required',
    });
    await expect(
      grantAcademyVideoTranscript({
        deps: deps({ gate }),
        slug: 'foundations-risk-first',
        caller,
        spine,
        transcripts: { 'foundations-risk-first': { language: 'en', text: 'TEST transcript.' } },
      }),
    ).rejects.toMatchObject({ code: 'academy.video_grant_required' });
  });

  it('a full caller below a published stake is refused captions and transcript', async () => {
    const spine = [
      {
        slug: 'foundations-risk-first',
        title: 'Risk first',
        path: 'foundations' as const,
        objectKey: 'foundations/risk-first.mp4',
        durationSeconds: 30,
        thumbnailUrl: null,
        language: 'en',
        captionsUrl: 'captions/risk-first.vtt',
      },
    ];
    const caller = { userId: USER, tier: 'full' as const };
    const gate = { minTier: 'full', minStake: '1' };
    const low = deps({ gate, stakeOf: async () => parseAmount('0') });
    await expect(grantAcademyVideoCaptions({ deps: low, slug: 'foundations-risk-first', caller, spine })).rejects.toMatchObject({
      code: 'academy.video_grant_required',
    });
    await expect(
      grantAcademyVideoTranscript({
        deps: low,
        slug: 'foundations-risk-first',
        caller,
        spine,
        transcripts: { 'foundations-risk-first': { language: 'en', text: 'TEST transcript.' } },
      }),
    ).rejects.toMatchObject({ code: 'academy.video_grant_required' });
  });

  it('tier shortfall is not a grant', async () => {
    await expect(
      grantAcademyVideoPlayback({
        deps: deps({ gate: { minTier: 'full', minStake: '0' } }),
        slug: 'foundations-risk-first',
        caller: { userId: USER, tier: 'none' },
      }),
    ).rejects.toMatchObject({ code: 'academy.video_grant_required' });
  });

  it('stake shortfall is not a grant', async () => {
    await expect(
      grantAcademyVideoPlayback({
        deps: deps({
          gate: { minTier: 'none', minStake: '10' },
          stakeOf: async () => parseAmount('1'),
        }),
        slug: 'foundations-risk-first',
        caller: { userId: USER, tier: 'none' },
      }),
    ).rejects.toMatchObject({ code: 'academy.video_grant_required' });
  });

  it('does not invent LiveKit or a bucket listing', () => {
    expect(listAcademyVideos.toString()).not.toMatch(/LiveKit|ListObjects/i);
  });

  it('unset URL TTL refuses by name — never invents 300 seconds', async () => {
    await expect(
      grantAcademyVideoPlayback({
        deps: deps({ storage: { ...storage, ttlSeconds: undefined } }),
        slug: 'foundations-risk-first',
        caller: { userId: USER, tier: 'none' },
      }),
    ).rejects.toMatchObject({ code: 'academy.video_url_ttl_unset' });
  });

  it('zero URL TTL refuses — clamp must not invent 1 second', async () => {
    await expect(
      grantAcademyVideoPlayback({
        deps: deps({ storage: { ...storage, ttlSeconds: 0 } }),
        slug: 'foundations-risk-first',
        caller: { userId: USER, tier: 'none' },
      }),
    ).rejects.toMatchObject({ code: 'academy.video_url_ttl_unset' });
  });

  it('owner-published TTL is the signed expiry — not a 300 stand-in', async () => {
    const play = await grantAcademyVideoPlayback({
      deps: deps({ storage: { ...storage, ttlSeconds: 120 } }),
      slug: 'foundations-risk-first',
      caller: { userId: USER, tier: 'none' },
    });
    expect(play.playbackUrl).toContain('X-Amz-Expires=120');
    expect(play.playbackUrl).not.toContain('X-Amz-Expires=300');
    expect(play.expiresAt.toISOString()).toBe('2026-08-23T12:02:00.000Z');
  });

  it('unset S3 region refuses by name — never invents us-east-1', async () => {
    await expect(
      grantAcademyVideoPlayback({
        deps: deps({ storage: { ...storage, region: '' } }),
        slug: 'foundations-risk-first',
        caller: { userId: USER, tier: 'none' },
      }),
    ).rejects.toMatchObject({ code: 'academy.video_s3_region_unset' });
  });

  it('whitespace S3 region refuses — trim must not invent us-east-1', async () => {
    await expect(
      grantAcademyVideoPlayback({
        deps: deps({ storage: { ...storage, region: '   ' } }),
        slug: 'foundations-risk-first',
        caller: { userId: USER, tier: 'none' },
      }),
    ).rejects.toMatchObject({ code: 'academy.video_s3_region_unset' });
  });

  it('owner-published region is the signing region — not a us-east-1 stand-in', async () => {
    const play = await grantAcademyVideoPlayback({
      deps: deps({ storage: { ...storage, region: 'eu-west-1' } }),
      slug: 'foundations-risk-first',
      caller: { userId: USER, tier: 'none' },
    });
    expect(play.playbackUrl).toContain('eu-west-1');
    expect(play.playbackUrl).not.toContain('us-east-1');
  });
});

/**
 * Academy stored video library (TRK-academy.video).
 *
 * Default off: blank S3 env → academy.video_storage_unconfigured.
 * Blank URL TTL → academy.video_url_ttl_unset (never invent seconds).
 * Blank region with storage otherwise on → academy.video_s3_region_unset
 * (never invent us-east-1).
 * Configured: signed expiring GET + tier/stake gate. URL without grant fails.
 * Not LiveKit (`socket.stream-provider`).
 */
import type { Amount } from '@intafaced/ledger-client';
import { AcademyError } from '../errors.js';
import { listVideoSpine, getVideoSpineItem } from './catalog.js';
import { captionsPublished, transcriptFor } from './player.js';
import { assertVideoEntitled, type VideoCaller, type VideoGateConfig } from './entitlement.js';
import {
  assertPlaybackUrlGranted,
  assertVideoStorageConfigured,
  isVideoStorageConfigured,
  issueGrant,
  signGetObjectUrl,
  type VideoStorageConfig,
} from './storage.js';

export type VideoLibraryDeps = {
  readonly storage: VideoStorageConfig | null;
  readonly gate: VideoGateConfig;
  readonly stakeOf: (userId: string) => Promise<Amount>;
  readonly now?: () => Date;
};

export type VideoListItem = {
  readonly slug: string;
  readonly title: string;
  readonly path: 'foundations' | 'markets' | 'builder' | 'sovereign';
  readonly durationSeconds: number | null;
  readonly thumbnailUrl: string | null;
  readonly language: string | null;
  readonly captionsUrl: string | null;
  readonly captionsPublished: boolean;
  readonly transcriptPublished: boolean;
};

export type VideoPlayback = {
  readonly slug: string;
  readonly playbackUrl: string;
  readonly expiresAt: Date;
  readonly grant: string;
};

export function unconfiguredVideoLibrary(): VideoLibraryDeps {
  return {
    storage: null,
    gate: { minTier: '', minStake: '' },
    stakeOf: async () => {
      throw new AcademyError('Stake gate unused while video storage is off', 'academy.stake_unavailable');
    },
  };
}

export function videoStorageFromEnv(env: {
  readonly ACADEMY_VIDEO_S3_ENDPOINT: string;
  readonly ACADEMY_VIDEO_S3_BUCKET: string;
  readonly ACADEMY_VIDEO_S3_ACCESS_KEY: string;
  readonly ACADEMY_VIDEO_S3_SECRET_KEY: string;
  readonly ACADEMY_VIDEO_S3_REGION: string;
  readonly ACADEMY_VIDEO_URL_TTL_SECONDS?: number;
}): VideoStorageConfig | null {
  const candidate: VideoStorageConfig = {
    endpoint: env.ACADEMY_VIDEO_S3_ENDPOINT,
    bucket: env.ACADEMY_VIDEO_S3_BUCKET,
    accessKey: env.ACADEMY_VIDEO_S3_ACCESS_KEY,
    secretKey: env.ACADEMY_VIDEO_S3_SECRET_KEY,
    region: env.ACADEMY_VIDEO_S3_REGION,
    ttlSeconds: env.ACADEMY_VIDEO_URL_TTL_SECONDS,
  };
  return isVideoStorageConfigured(candidate) ? candidate : null;
}

export function videoGateFromEnv(env: {
  readonly ACADEMY_VIDEO_MIN_TIER: string;
  readonly ACADEMY_VIDEO_MIN_STAKE: string;
}): VideoGateConfig {
  return { minTier: env.ACADEMY_VIDEO_MIN_TIER, minStake: env.ACADEMY_VIDEO_MIN_STAKE };
}

export function listAcademyVideos(deps: VideoLibraryDeps): readonly VideoListItem[] {
  assertVideoStorageConfigured(deps.storage);
  return listVideoSpine().map((item) => ({
    slug: item.slug,
    title: item.title,
    path: item.path,
    durationSeconds: item.durationSeconds,
    thumbnailUrl: item.thumbnailUrl,
    language: item.language,
    captionsUrl: item.captionsUrl,
    captionsPublished: captionsPublished(item),
    transcriptPublished: transcriptFor(item.slug) !== null,
  }));
}

export async function grantAcademyVideoPlayback(input: {
  readonly deps: VideoLibraryDeps;
  readonly slug: string;
  readonly caller: VideoCaller;
}): Promise<VideoPlayback> {
  const storage = assertVideoStorageConfigured(input.deps.storage);
  const item = getVideoSpineItem(input.slug);
  if (!item) {
    throw new AcademyError(`Video "${input.slug}" is not on the named spine`, 'academy.video_grant_required');
  }
  const stake = await input.deps.stakeOf(input.caller.userId);
  assertVideoEntitled({ gate: input.deps.gate, caller: input.caller, stake });
  const now = input.deps.now?.() ?? new Date();
  const issued = signGetObjectUrl(storage, item.objectKey, now);
  const bound = `${input.caller.userId}|${item.slug}|${item.objectKey}`;
  return {
    slug: item.slug,
    playbackUrl: issued.playbackUrl,
    expiresAt: issued.expiresAt,
    grant: issueGrant(storage.secretKey, bound, issued.expiresAt),
  };
}

export function assertAcademyVideoUrlGranted(deps: VideoLibraryDeps, playbackUrl: string, now = new Date()): void {
  const storage = assertVideoStorageConfigured(deps.storage);
  if (!playbackUrl || playbackUrl.indexOf('X-Amz-Signature=') === -1) {
    throw new AcademyError('Video URL without grant', 'academy.video_grant_required');
  }
  assertPlaybackUrlGranted(storage, playbackUrl, now);
}

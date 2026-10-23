/**
 * AC-videos-01 — captions track, transcript, and whether a stored watch
 * position meets the owner threshold.
 *
 * `videos` and `videoPlayback` stay the doors the Videos screen already
 * calls. This file does not invent a transcript, a captions URL, a
 * duration, or a threshold. A blank threshold refuses. An unpublished
 * track refuses when asked for. Playback of the file does not wait on either.
 */
import { AcademyError } from '../errors.js';
import { getVideoSpineItem, type VideoSpineEntry } from './catalog.js';

export type PublishedTranscript = {
  readonly language: string;
  readonly text: string;
};

/** Shipped spine has no owner-published transcript. Tests pass their own map. */
export const VIDEO_TRANSCRIPTS: Readonly<Record<string, PublishedTranscript>> = {};

export type VideoCaptionsTrack = {
  readonly slug: string;
  readonly captionsUrl: string;
  readonly language: string | null;
};

export type VideoTranscriptTrack = {
  readonly slug: string;
  readonly language: string;
  readonly text: string;
};

export type WatchedDecision = {
  readonly videoSlug: string;
  readonly positionSeconds: number | null;
  readonly thresholdSeconds: number;
  readonly watched: boolean;
};

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== '';

export function captionsPublished(item: Pick<VideoSpineEntry, 'captionsUrl'>): boolean {
  return filled(item.captionsUrl);
}

export function transcriptFor(
  slug: string,
  transcripts: Readonly<Record<string, PublishedTranscript>> = VIDEO_TRANSCRIPTS,
): PublishedTranscript | null {
  const row = transcripts[slug];
  if (!row || !filled(row.language) || !filled(row.text)) return null;
  return { language: row.language.trim(), text: row.text };
}

export function requireSpineItem(slug: string, spine?: readonly VideoSpineEntry[]): VideoSpineEntry {
  const item = spine ? spine.find((row) => row.slug === slug) : getVideoSpineItem(slug);
  if (!item) {
    throw new AcademyError(`Video "${slug}" is not on the named spine`, 'academy.video_not_found');
  }
  return item;
}

/** Captions track. No URL means unpublished, not an empty track. */
export function readVideoCaptions(slug: string, spine?: readonly VideoSpineEntry[]): VideoCaptionsTrack {
  const item = requireSpineItem(slug, spine);
  if (!filled(item.captionsUrl)) {
    throw new AcademyError('academy.video_captions_unpublished', 'academy.video_captions_unpublished');
  }
  return {
    slug: item.slug,
    captionsUrl: item.captionsUrl.trim(),
    language: filled(item.language) ? item.language.trim() : null,
  };
}

/** Transcript text. Blank language or blank text is unpublished. */
export function readVideoTranscript(
  slug: string,
  transcripts: Readonly<Record<string, PublishedTranscript>> = VIDEO_TRANSCRIPTS,
  spine?: readonly VideoSpineEntry[],
): VideoTranscriptTrack {
  const item = requireSpineItem(slug, spine);
  const row = transcriptFor(item.slug, transcripts);
  if (!row) {
    throw new AcademyError('academy.video_transcript_unpublished', 'academy.video_transcript_unpublished');
  }
  return { slug: item.slug, language: row.language, text: row.text };
}

/**
 * Positive integer seconds. Blank, zero, negative, and fractions are not
 * a published threshold. Zero would mark a video watched before any
 * position was stored, so it is not a real setting here.
 */
export function requireWatchThresholdSeconds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AcademyError('academy.watch_threshold_unset', 'academy.watch_threshold_unset');
  }
  return value;
}

/**
 * Stored position against the owner threshold. A missing row is not
 * watched. The threshold is never lowered to a duration, and a null
 * duration is not invented so a fraction could be applied.
 */
export function decideWatched(input: {
  readonly videoSlug: string;
  readonly positionSeconds: number | null;
  readonly thresholdSeconds: number | undefined;
}): WatchedDecision {
  const thresholdSeconds = requireWatchThresholdSeconds(input.thresholdSeconds);
  const position = input.positionSeconds;
  return {
    videoSlug: input.videoSlug,
    positionSeconds: position,
    thresholdSeconds,
    watched: position !== null && position >= thresholdSeconds,
  };
}

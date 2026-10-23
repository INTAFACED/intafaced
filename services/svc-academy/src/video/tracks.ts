/**
 * AC-videos-01 — videos on curriculum items and their caption tracks.
 *
 * Staff attach a spine video to an item (the item then completes by the `watch` rule) and upload one WebVTT caption
 * track per language. A track is stored as uploaded and read back as cues; the transcript is the same cues, so it
 * follows the language the learner picks. Nothing here invents a cue, a language or a rendition.
 */
import type { Sql } from 'postgres';
import { AcademyError } from '../errors.js';
import { transaction } from '@intafaced/db';

export type VideoCue = { startMs: number; endMs: number; text: string };
export type VideoTrack = { language: string; label: string; cues: VideoCue[] };

const MAX_CUES = 5000;
const MAX_CUE_TEXT = 1000;
const TIMESTAMP = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;

const invalid = (why: string): never => {
  throw new AcademyError(`academy.captions_invalid ${why}`, 'academy.captions_invalid');
};

function millis(stamp: string, line: number): number {
  const m = TIMESTAMP.exec(stamp);
  if (!m) return invalid(`line ${line}: "${stamp.slice(0, 40)}" is not a WebVTT timestamp`);
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

/**
 * The cues of one WebVTT file (UTF-8 text). The file must start with `WEBVTT`; header lines up to the first blank line
 * and NOTE, STYLE and REGION blocks are skipped; each cue needs an end after its start and some text. Cue settings after the timing are dropped.
 */
export function parseVtt(vtt: string): VideoCue[] {
  const lines = vtt.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0] ?? '')) invalid('the file does not start with WEBVTT');
  const cues: VideoCue[] = [];
  // Header lines (`Kind:`, `Language:` and the like) run until the first blank line.
  let i = 1;
  while (i < lines.length && lines[i]!.trim() !== '') {
    if (lines[i]!.includes('-->')) invalid(`line ${i + 1}: a cue needs a blank line after the header`);
    i++;
  }
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === '') i++;
    if (i >= lines.length) break;
    const start = i;
    while (i < lines.length && lines[i]!.trim() !== '') i++;
    const block = lines.slice(start, i);
    if (/^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(block[0]!)) continue;
    const at = block.findIndex((line) => line.includes('-->'));
    if (at === -1 || at > 1) invalid(`line ${start + 1}: a cue block has no timing line`);
    const [from, rest] = block[at]!.split('-->').map((part) => part.trim());
    const startMs = millis(from!, start + at + 1);
    const endMs = millis(rest!.split(/[ \t]+/)[0]!, start + at + 1);
    if (endMs <= startMs) invalid(`line ${start + at + 1}: a cue ends before it starts`);
    const text = block
      .slice(at + 1)
      .join('\n')
      .trim();
    if (!text) invalid(`line ${start + at + 1}: a cue has no text`);
    if (text.length > MAX_CUE_TEXT) invalid(`line ${start + at + 1}: a cue is longer than ${MAX_CUE_TEXT} characters`);
    cues.push({ startMs, endMs, text });
    if (cues.length > MAX_CUES) invalid(`more than ${MAX_CUES} cues`);
  }
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export class VideoTracks {
  constructor(private readonly sql: Sql) {}

  async itemVideo(itemSlug: string): Promise<string | null> {
    const rows = await this.sql<Array<{ video_slug: string }>>`
      SELECT video_slug FROM academy.item_videos WHERE item_slug = ${itemSlug}
    `;
    return rows[0]?.video_slug ?? null;
  }

  /** Item → video for the given items (all attached items when `itemSlugs` is omitted). */
  async itemVideos(itemSlugs?: readonly string[]): Promise<Map<string, string>> {
    if (itemSlugs && itemSlugs.length === 0) return new Map();
    const rows = itemSlugs
      ? await this.sql<Array<{ item_slug: string; video_slug: string }>>`
          SELECT item_slug, video_slug FROM academy.item_videos WHERE item_slug IN ${this.sql([...itemSlugs])}
        `
      : await this.sql<Array<{ item_slug: string; video_slug: string }>>`SELECT item_slug, video_slug FROM academy.item_videos`;
    return new Map(rows.map((row) => [row.item_slug, row.video_slug]));
  }

  async itemsWithVideo(videoSlug: string): Promise<string[]> {
    const rows = await this.sql<Array<{ item_slug: string }>>`
      SELECT item_slug FROM academy.item_videos WHERE video_slug = ${videoSlug} ORDER BY item_slug
    `;
    return rows.map((row) => row.item_slug);
  }

  async setItemVideo(input: { itemSlug: string; videoSlug: string | null; operatorId: string; reason: string; now: Date }) {
    if (input.videoSlug === null) {
      await this.sql`DELETE FROM academy.item_videos WHERE item_slug = ${input.itemSlug}`;
      return;
    }
    await this.sql`
      INSERT INTO academy.item_videos (item_slug, video_slug, reason, set_by, set_at)
      VALUES (${input.itemSlug}, ${input.videoSlug}, ${input.reason}, ${input.operatorId}, ${input.now})
      ON CONFLICT (item_slug) DO UPDATE SET
        video_slug = EXCLUDED.video_slug, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
    `;
  }

  /** The video's caption tracks in the order staff listed them, read back as cues. */
  async tracks(videoSlug: string): Promise<VideoTrack[]> {
    const rows = await this.sql<Array<{ language: string; label: string; vtt: string }>>`
      SELECT language, label, vtt FROM academy.video_tracks WHERE video_slug = ${videoSlug} ORDER BY position
    `;
    return rows.map((row) => ({ language: row.language, label: row.label, cues: parseVtt(row.vtt) }));
  }

  /** Replaces every track of one video. Each file is checked before anything is written; `[]` removes them all. */
  async setTracks(input: {
    videoSlug: string;
    tracks: readonly { language: string; label: string; vtt: string }[];
    operatorId: string;
    reason: string;
    now: Date;
  }): Promise<VideoTrack[]> {
    const languages = new Set(input.tracks.map((track) => track.language));
    if (languages.size !== input.tracks.length) invalid('two tracks share a language');
    const parsed = input.tracks.map((track) => ({ language: track.language, label: track.label.trim(), cues: parseVtt(track.vtt) }));
    await transaction(this.sql, async (tx) => {
      await tx`DELETE FROM academy.video_tracks WHERE video_slug = ${input.videoSlug}`;
      for (const [position, track] of input.tracks.entries()) {
        await tx`
          INSERT INTO academy.video_tracks (video_slug, language, label, vtt, position, reason, set_by, set_at)
          VALUES (${input.videoSlug}, ${track.language}, ${track.label.trim()}, ${track.vtt}, ${position},
                  ${input.reason}, ${input.operatorId}, ${input.now})
        `;
      }
    });
    return parsed;
  }
}

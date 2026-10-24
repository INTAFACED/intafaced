/**
 * AC-videos-02 — a course item's video, caption files and handouts.
 *
 * An upload is three calls. `intent` checks the declared file against the owner's limits (size, video types, handout
 * types; any blank refuses `academy.upload_limits_unset`) and answers with a signed PUT to our own object store, so the
 * upload does not pass through svc-academy. The row is keyed `media:<item>:<kind>:<sha256>` (the unique key): the same file
 * resumes the same row, and a file already confirmed needs no second upload. `confirm` reads the stored object back
 * whole (its size, SHA-256 and first 16 bytes): a missing object, or a size or SHA-256 other than the declared ones,
 * refuses `academy.upload_incomplete` and the row stays pending; leading bytes that are not the declared type mark the row
 * refused with its reason and refuse `academy.file_type_mismatch`. Only a ready file is ever given a viewing address.
 *
 * An item's video is its newest checked one. Captions are one SRT or WebVTT file per video and language, parsed into
 * cues, so a re-cut starts with none of the old timings; the first line that is not a caption is
 * returned with its number and nothing is stored. No money moves here.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type {
  AcademyItemMedia,
  AcademyMedia,
  AcademyMediaIntent,
  AcademyMediaIntentInput,
  AcademySetItemCaptionsInput,
  AcademyUploadLimits,
} from '@intafaced/contracts';
import { ACADEMY_ITEMS_WITHOUT_LESSON } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { isVideoStorageConfigured, signGetObjectUrl, signPutObjectUrl, type VideoStorageConfig } from '../video/storage.js';
import { parseSrt, parseVtt, type VideoCue } from '../video/tracks.js';

const MEDIA_SHOWN = 50;
const READ_BACK_BASE_MS = 60_000;

/** The leading bytes of each type svc-academy can check. A type with no entry here is never accepted. */
const SIGNATURES: Readonly<Record<string, { offset: number; bytes: readonly number[] }>> = {
  'video/webm': { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  'video/mp4': { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  'video/quicktime': { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  'application/pdf': { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  'image/png': { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/jpeg': { offset: 0, bytes: [0xff, 0xd8, 0xff] },
  'image/gif': { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
};

/** What the leading bytes look like, for the refusal, or null when no known type matches. */
function sniff(head: Uint8Array): string | null {
  for (const [type, sig] of Object.entries(SIGNATURES)) if (matches(head, sig)) return type;
  return null;
}

function matches(head: Uint8Array, sig: { offset: number; bytes: readonly number[] }): boolean {
  return sig.bytes.every((b, i) => head[sig.offset + i] === b);
}

export type UploadLimits = {
  readonly maxBytes: number | null;
  readonly videoTypes: readonly string[] | null;
  readonly handoutTypes: readonly string[] | null;
};

type MediaRow = {
  id: string;
  item_id: string;
  kind: 'video' | 'handout';
  sha256: string;
  file_name: string;
  content_type: string;
  bytes: string | number | bigint;
  object_key: string;
  state: 'pending' | 'ready' | 'refused';
  refusal: string | null;
  created_at: Date;
};

type CaptionRow = { language: string; label: string; format: 'srt' | 'vtt'; cues: VideoCue[] };

type ReadBack = { status: number; bytes: number; head: Uint8Array; sha256: string };

/**
 * The stored object read back whole through a signed GET: its size, SHA-256 and first 16 bytes. It stops one byte past
 * the declared size. Swapped in tests.
 */
export type ReadBackFn = (url: string, declaredBytes: number) => Promise<ReadBack>;

export const readBackOverHttp: ReadBackFn = async (url, declaredBytes) => {
  // A minute plus a second for each MiB declared, so a large file is read whole and a stuck store still ends.
  const timeout = READ_BACK_BASE_MS + Math.ceil(declaredBytes / 1_048_576) * 1000;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const hash = createHash('sha256');
  const head = new Uint8Array(16);
  let bytes = 0;
  const reader = res.ok ? res.body?.getReader() : undefined;
  if (reader) {
    while (bytes <= declaredBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes < 16) head.set(value.subarray(0, 16 - bytes), bytes);
      bytes += value.byteLength;
      hash.update(value);
    }
    await reader.cancel().catch(() => undefined);
  } else await res.body?.cancel().catch(() => undefined);
  return { status: res.status, bytes, head: head.subarray(0, Math.min(bytes, 16)), sha256: hash.digest('hex') };
};

export class CourseMedia {
  constructor(
    private readonly sql: Sql,
    private readonly storage: VideoStorageConfig | null,
    private readonly limits: UploadLimits,
    private readonly readBack: ReadBackFn = readBackOverHttp,
  ) {}

  /** One item's uploads (newest first), its current video and that video's caption languages, and the owner's limits. */
  async itemMedia(itemId: string, now: Date): Promise<AcademyItemMedia> {
    await this.item(itemId);
    const videoId = await this.currentVideo(itemId);
    const [rows, captions] = await Promise.all([
      this.sql<MediaRow[]>`
        SELECT * FROM academy.course_media WHERE item_id = ${itemId} ORDER BY created_at DESC, id LIMIT ${MEDIA_SHOWN}
      `,
      videoId === null
        ? Promise.resolve([] as CaptionRow[])
        : this.sql<CaptionRow[]>`
            SELECT language, label, format, cues FROM academy.course_item_captions WHERE media_id = ${videoId} ORDER BY language
          `,
    ]);
    return {
      itemId,
      videoId,
      limits: this.publishedLimits(),
      media: rows.map((row) => this.toMedia(row, now)),
      captions: captions.map((c) => ({
        language: c.language,
        label: c.label,
        format: c.format,
        cues: c.cues.length,
        firstCue: c.cues[0]?.text ?? '',
      })),
    };
  }

  /** The declared file checked against the owner's limits, its row, and a signed PUT for its bytes. */
  async intent(input: AcademyMediaIntentInput & { operatorId: string; now: Date }): Promise<AcademyMediaIntent> {
    const { maxBytes, types } = this.limitsFor(input.kind);
    if (input.bytes > maxBytes)
      throw new AcademyError(`the file is ${input.bytes} bytes; the limit is ${maxBytes}`, 'academy.upload_too_large');
    if (!types.includes(input.contentType))
      throw new AcademyError(`${input.contentType} is not an accepted ${input.kind} type`, 'academy.upload_type_refused');
    if (!SIGNATURES[input.contentType])
      throw new AcademyError(`the content of ${input.contentType} files cannot be checked`, 'academy.upload_type_refused');
    const item = await this.item(input.itemId);
    const objectKey = `courses/${item.course_id}/items/${item.id}/${input.kind}/${input.sha256}`;
    // A ready row is kept as it is; a pending or refused one takes the new declaration and is checked again.
    const [row] = await this.sql<MediaRow[]>`
      INSERT INTO academy.course_media
        (item_id, kind, sha256, file_name, content_type, bytes, object_key, state, created_by, created_at)
      VALUES (${item.id}, ${input.kind}, ${input.sha256}, ${input.fileName}, ${input.contentType}, ${input.bytes},
              ${objectKey}, 'pending', ${input.operatorId}, ${input.now})
      ON CONFLICT (item_id, kind, sha256) DO UPDATE SET
        file_name    = CASE WHEN academy.course_media.state = 'ready' THEN academy.course_media.file_name ELSE excluded.file_name END,
        content_type = CASE WHEN academy.course_media.state = 'ready' THEN academy.course_media.content_type ELSE excluded.content_type END,
        bytes        = CASE WHEN academy.course_media.state = 'ready' THEN academy.course_media.bytes ELSE excluded.bytes END,
        refusal      = NULL,
        state        = CASE WHEN academy.course_media.state = 'ready' THEN 'ready' ELSE 'pending' END
      RETURNING *
    `;
    if (row!.state === 'ready') return { media: this.toMedia(row!, input.now), uploadUrl: null };
    const { uploadUrl } = signPutObjectUrl(this.requireStorage(), objectKey, input.now);
    return { media: this.toMedia(row!, input.now), uploadUrl };
  }

  /** The stored object read back whole: its size, SHA-256 and leading bytes against what was declared. */
  async confirm(input: { mediaId: string; operatorId: string; now: Date }): Promise<AcademyMedia> {
    const [row] = await this.sql<MediaRow[]>`SELECT * FROM academy.course_media WHERE id = ${input.mediaId}`;
    if (!row) throw new AcademyError('no upload with that id', 'academy.media_not_found');
    if (row.state === 'ready') return this.toMedia(row, input.now);
    if (row.state === 'refused') throw new AcademyError(row.refusal ?? 'the stored file was refused', 'academy.file_type_mismatch');
    const { playbackUrl } = signGetObjectUrl(this.requireStorage(), row.object_key, input.now);
    const declared = Number(row.bytes);
    const back = await this.readBack(playbackUrl, declared);
    if (back.status !== 200) throw new AcademyError('the file has not reached storage; send it again', 'academy.upload_incomplete');
    if (back.bytes !== declared || back.sha256 !== row.sha256)
      throw new AcademyError(
        back.bytes !== declared
          ? `storage holds ${back.bytes > declared ? 'more than' : back.bytes} bytes; ${declared} were declared`
          : 'the stored bytes are not the file that was declared; send it again',
        'academy.upload_incomplete',
      );
    // The checks hold only for the declaration read above: a new declaration of the same file in the meantime wins.
    const same = this.sql`id = ${row.id} AND state = 'pending' AND content_type = ${row.content_type} AND bytes = ${declared}`;
    const sig = SIGNATURES[row.content_type];
    if (!sig || !matches(back.head, sig)) {
      const seen = sniff(back.head);
      const refusal = `the file was declared ${row.content_type} but its content is ${seen ?? 'not a type we recognise'}`;
      await this.sql`UPDATE academy.course_media SET state = 'refused', refusal = ${refusal}, confirmed_at = ${input.now} WHERE ${same}`;
      throw new AcademyError(refusal, 'academy.file_type_mismatch');
    }
    const [ready] = await this.sql<MediaRow[]>`
      UPDATE academy.course_media SET state = 'ready', refusal = NULL, confirmed_at = ${input.now} WHERE ${same} RETURNING *
    `;
    if (!ready) throw new AcademyError('the upload changed while it was checked; check it again', 'academy.upload_incomplete');
    return this.toMedia(ready, input.now);
  }

  /** One language's caption file for the item's stored video; a malformed line is returned and nothing is stored. */
  async setCaptions(
    input: AcademySetItemCaptionsInput & { operatorId: string; now: Date },
  ): Promise<{ outcome: 'saved'; media: AcademyItemMedia } | { outcome: 'invalid'; problem: string; media: AcademyItemMedia }> {
    await this.item(input.itemId);
    const video = await this.currentVideo(input.itemId);
    if (!video) throw new AcademyError('upload and confirm a video before its captions', 'academy.item_video_missing');
    let cues: VideoCue[];
    try {
      cues = input.format === 'srt' ? parseSrt(input.text) : parseVtt(input.text);
    } catch (error) {
      if (error instanceof AcademyError && error.code === 'academy.captions_invalid') {
        const problem = error.message.replace(/^academy\.captions_invalid\s*/, '');
        return { outcome: 'invalid', problem, media: await this.itemMedia(input.itemId, input.now) };
      }
      throw error;
    }
    await this.sql`
      INSERT INTO academy.course_item_captions (item_id, media_id, language, label, format, source, cues, set_by, set_at)
      VALUES (${input.itemId}, ${video}, ${input.language}, ${input.label}, ${input.format}, ${input.text}, ${this.sql.json(cues)},
              ${input.operatorId}, ${input.now})
      ON CONFLICT (media_id, language) DO UPDATE SET
        label = excluded.label, format = excluded.format, source = excluded.source, cues = excluded.cues,
        set_by = excluded.set_by, set_at = excluded.set_at
    `;
    return { outcome: 'saved', media: await this.itemMedia(input.itemId, input.now) };
  }

  /** The item's video: the newest one checked, or null. Captions belong to it. */
  private async currentVideo(itemId: string): Promise<string | null> {
    const [video] = await this.sql<{ id: string }[]>`
      SELECT id FROM academy.course_media WHERE item_id = ${itemId} AND kind = 'video' AND state = 'ready'
      ORDER BY confirmed_at DESC, id LIMIT 1
    `;
    return video?.id ?? null;
  }

  private publishedLimits(): AcademyUploadLimits {
    return {
      maxBytes: this.limits.maxBytes,
      videoTypes: this.limits.videoTypes ? [...this.limits.videoTypes] : null,
      handoutTypes: this.limits.handoutTypes ? [...this.limits.handoutTypes] : null,
    };
  }

  private limitsFor(kind: 'video' | 'handout'): { maxBytes: number; types: readonly string[] } {
    const types = kind === 'video' ? this.limits.videoTypes : this.limits.handoutTypes;
    if (this.limits.maxBytes === null || !types || types.length === 0)
      throw new AcademyError(`the owner has not set the upload size limit and the accepted ${kind} types`, 'academy.upload_limits_unset');
    return { maxBytes: this.limits.maxBytes, types };
  }

  private requireStorage(): VideoStorageConfig {
    if (!isVideoStorageConfigured(this.storage))
      throw new AcademyError('Video object storage is not configured', 'academy.video_storage_unconfigured');
    return this.storage;
  }

  private async item(itemId: string): Promise<{ id: string; course_id: string }> {
    const [row] = await this.sql<{ id: string; course_id: string; kind: string }[]>`
      SELECT id, course_id, kind FROM academy.course_items WHERE id = ${itemId}
    `;
    if (!row) throw new AcademyError('no outline item with that id', 'academy.outline_item_unknown');
    if ((ACADEMY_ITEMS_WITHOUT_LESSON as readonly string[]).includes(row.kind))
      throw new AcademyError(`a ${row.kind} holds no files`, 'academy.item_has_no_lesson');
    return row;
  }

  private toMedia(row: MediaRow, now: Date): AcademyMedia {
    return {
      id: row.id,
      kind: row.kind,
      fileName: row.file_name,
      contentType: row.content_type,
      bytes: Number(row.bytes),
      state: row.state,
      refusal: row.refusal,
      createdAt: row.created_at.toISOString(),
      url: row.state === 'ready' ? this.viewUrl(row.object_key, now) : null,
    };
  }

  /** A ready file's short-lived address; null while storage or its URL lifetime is not set (the list still reads). */
  private viewUrl(objectKey: string, now: Date): string | null {
    if (!isVideoStorageConfigured(this.storage)) return null;
    try {
      return signGetObjectUrl(this.storage, objectKey, now).playbackUrl;
    } catch (error) {
      if (error instanceof AcademyError) return null;
      throw error;
    }
  }
}

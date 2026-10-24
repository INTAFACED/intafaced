import type { AcademyItemMedia, AcademyMedia, AcademyMediaIntent, AcademyUploadLimits } from '@intafaced/contracts/academy-courses';
import type { Part } from '@/lib/desk/part';

/**
 * Course files (AC-videos-02): an item's video, caption files and handouts, and the owner's upload limits. Pure, so
 * the server loader, the route and the browser components share it.
 */
export type { AcademyItemMedia, AcademyMedia, AcademyMediaIntent, AcademyUploadLimits };

export interface MediaView {
  readonly media: Part<AcademyItemMedia>;
  readonly asOf: string;
}

export type MediaDeskReply =
  | {
      readonly ok: true;
      readonly what: string;
      readonly intent?: AcademyMediaIntent;
      readonly media?: AcademyMedia;
      readonly itemMedia?: AcademyItemMedia;
    }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };

/**
 * The browser's own check before a byte is sent: blank limits, a file over the size or of a type not accepted is
 * refused here with no request. svc-academy checks the same again.
 */
export function checkBeforeUpload(
  limits: AcademyUploadLimits,
  kind: 'video' | 'handout',
  file: { size: number; type: string },
): { ok: true } | { ok: false; title: string; body: string } {
  const types = kind === 'video' ? limits.videoTypes : limits.handoutTypes;
  if (limits.maxBytes === null || types === null)
    return {
      ok: false,
      title: 'The upload limits are not set',
      body: `The owner has not set the largest file or the accepted ${kind} types, so nothing is uploaded.`,
    };
  if (file.size > limits.maxBytes)
    return {
      ok: false,
      title: 'The file is over the size limit',
      body: `This file is ${file.size} bytes and the limit is ${limits.maxBytes}. It was not sent.`,
    };
  if (!types.includes(file.type))
    return {
      ok: false,
      title: 'This file type is not accepted',
      body: `${file.type || 'This file'} is not one of the accepted ${kind} types (${types.join(', ')}). It was not sent.`,
    };
  return { ok: true };
}

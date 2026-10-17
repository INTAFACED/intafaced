/**
 * Operator notes: founder-only notes, tags and a flag on a merchant (`founderAdmin.ops.notes.*`). The merchant never reads them.
 * Notes are append-only: retracting records who withdrew one and why, and the text stays in the history.
 */
export interface OperatorNote {
  readonly noteId: string;
  readonly merchantId: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly flagged: boolean;
  readonly authorId: string;
  readonly createdAt: string;
  readonly retractedAt: string | null;
  readonly retractedBy: string | null;
  readonly retractReason: string | null;
}
export interface NotePage {
  readonly items: readonly OperatorNote[];
  readonly nextCursor: string | null;
}

export const NOTE_BODY_MAX = 4000;
export const NOTE_TAG_MAX = 40;
export const NOTE_TAGS_MAX = 20;
export const RETRACT_REASON_MIN = 3;
export const RETRACT_REASON_MAX = 500;

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const strOrNull = (v: unknown): v is string | null => v === null || str(v);

export function asNote(raw: unknown): OperatorNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    !str(r.noteId) ||
    !str(r.merchantId) ||
    typeof r.body !== 'string' ||
    !Array.isArray(r.tags) ||
    !r.tags.every((t) => typeof t === 'string') ||
    typeof r.flagged !== 'boolean' ||
    !str(r.authorId) ||
    !str(r.createdAt) ||
    !strOrNull(r.retractedAt) ||
    !strOrNull(r.retractedBy) ||
    !strOrNull(r.retractReason)
  )
    return null;
  return {
    noteId: r.noteId,
    merchantId: r.merchantId,
    body: r.body,
    tags: r.tags as string[],
    flagged: r.flagged,
    authorId: r.authorId,
    createdAt: r.createdAt,
    retractedAt: r.retractedAt,
    retractedBy: r.retractedBy,
    retractReason: r.retractReason,
  };
}

export function asNotePage(raw: unknown): NotePage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items) || !(r.nextCursor === null || str(r.nextCursor))) return null;
  const items: OperatorNote[] = [];
  for (const item of r.items) {
    const note = asNote(item);
    if (!note) return null;
    items.push(note);
  }
  return { items, nextCursor: r.nextCursor as string | null };
}

/** Tags typed as "a, b, c": trimmed, de-duplicated, never more than the service takes. Null when one tag is too long. */
export function parseTags(text: string): string[] | null {
  const tags = [
    ...new Set(
      text
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
  if (tags.length > NOTE_TAGS_MAX || tags.some((t) => t.length > NOTE_TAG_MAX)) return null;
  return tags;
}

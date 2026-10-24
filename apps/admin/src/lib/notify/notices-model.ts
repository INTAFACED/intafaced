/**
 * The announcement desk (SP-status-03): announcements on svc-notify's notice board as the founders see them (drafts
 * too), each with the category it is filed under, and the founders' category list. Pure and browser safe.
 *
 * An announcement is published like any notice: the author asks identity for an approval bound to the exact draft
 * (category included), a different founder approves it, and the founder who asked publishes it. The category list is an
 * owner value on the status page row: blank means the kinds alone, and svc-notify then refuses any category.
 */
import { NOTICE_CATEGORIES_MAX, NOTICE_CATEGORY_ID, STATUS_PAGE_REASON_MAX, type NoticeCategory } from '@intafaced/contracts/status-page';
import type { Part } from '@/lib/desk/part';
import type { PublishApproval } from './incidents-model';

export type { NoticeCategory };

/** svc-notify's bounds: at most 20 categories, ids like `new-listings`, names up to 60 characters. */
export const CATEGORIES_MAX = NOTICE_CATEGORIES_MAX;
export const CATEGORY_ID = NOTICE_CATEGORY_ID;
export const CATEGORY_NAME_MAX = 60;
export const CATEGORIES_REASON_MAX = STATUS_PAGE_REASON_MAX;

export interface Announcement {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly status: 'draft' | 'published';
  readonly publishedAt: string | null;
  readonly version: number;
  readonly category: NoticeCategory | null;
  readonly authorId: string;
  readonly createdAt: string;
}

export interface NoticeCategories {
  /** Null when no list is set. */
  readonly list: readonly NoticeCategory[] | null;
  /** The status page revision the list was read at: a change names it. */
  readonly revision: number;
}

export interface NoticesDeskView {
  readonly announcements: Part<readonly Announcement[]>;
  readonly categories: Part<NoticeCategories>;
  readonly approvals: Part<readonly PublishApproval[]>;
  readonly me: string;
  readonly asOf: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function readCategory(v: unknown): NoticeCategory | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.name !== 'string') return undefined;
  return { id: v.id, name: v.name };
}

/** `notify.operatorNotices` rows, read whole or not at all. A row from before categories carries none. */
export function readAnnouncements(raw: unknown): Announcement[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Announcement[] = [];
  for (const n of raw) {
    if (
      !isRecord(n) ||
      typeof n.id !== 'string' ||
      typeof n.kind !== 'string' ||
      typeof n.title !== 'string' ||
      typeof n.body !== 'string' ||
      (n.status !== 'draft' && n.status !== 'published') ||
      !strOrNull(n.publishedAt) ||
      !Number.isInteger(n.version) ||
      typeof n.authorId !== 'string' ||
      typeof n.createdAt !== 'string'
    )
      return null;
    const category = readCategory(n.category);
    if (category === undefined) return null;
    out.push({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      status: n.status,
      publishedAt: n.publishedAt,
      version: n.version as number,
      category,
      authorId: n.authorId,
      createdAt: n.createdAt,
    });
  }
  return out;
}

/** The list and revision from `statusPage.definition`; null for any other shape. A definition without the field has none set. */
export function readCategories(raw: unknown): NoticeCategories | null {
  if (!isRecord(raw) || !Number.isInteger(raw.revision)) return null;
  const listed = raw.noticeCategories ?? null;
  if (listed === null) return { list: null, revision: raw.revision as number };
  if (!Array.isArray(listed)) return null;
  const list: NoticeCategory[] = [];
  for (const c of listed) {
    const category = readCategory(c);
    if (!category) return null;
    list.push(category);
  }
  return { list, revision: raw.revision as number };
}

/**
 * The category list as the founder types it: one per line, `id: Name`. Blank is no list. Null, with why, when a line is
 * not in that shape, an id repeats, or there are too many.
 */
export function parseCategories(text: string): { ok: true; list: NoticeCategory[] | null } | { ok: false; why: string } {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return { ok: true, list: null };
  if (lines.length > CATEGORIES_MAX) return { ok: false, why: `At most ${CATEGORIES_MAX} categories.` };
  const list: NoticeCategory[] = [];
  for (const line of lines) {
    const at = line.indexOf(':');
    const id = at < 0 ? '' : line.slice(0, at).trim();
    const name = at < 0 ? '' : line.slice(at + 1).trim();
    if (!CATEGORY_ID.test(id) || name === '' || name.length > CATEGORY_NAME_MAX)
      return {
        ok: false,
        why: `"${line}" is not "id: Name". An id is 2 to 40 lowercase letters, digits or dashes; a name is 1 to ${CATEGORY_NAME_MAX} characters.`,
      };
    if (list.some((c) => c.id === id)) return { ok: false, why: `The id "${id}" is listed twice.` };
    list.push({ id, name });
  }
  return { ok: true, list };
}

export const categoriesText = (list: readonly NoticeCategory[] | null): string => (list ?? []).map((c) => `${c.id}: ${c.name}`).join('\n');

export interface AnnouncementDraftInput {
  readonly title: string;
  readonly body: string;
  readonly category: string | null;
}

/** Checked before it leaves the browser; svc-notify checks it again, the category against the list as it stands. */
export function checkAnnouncementDraft(input: AnnouncementDraftInput): { ok: true } | { ok: false; why: string } {
  if (input.title.trim() === '' || input.title.trim().length > 200) return { ok: false, why: 'The title is 1 to 200 characters.' };
  if (input.body.trim() === '' || input.body.trim().length > 8000) return { ok: false, why: 'The message is 1 to 8000 characters.' };
  if (input.category !== null && !CATEGORY_ID.test(input.category)) return { ok: false, why: 'Choose a category from the list.' };
  return { ok: true };
}

/**
 * Help-article authoring on the desk (SP-kb-01, SP-kb-02): what a founder can send, checked before the network.
 *
 * A draft is typed text saved from the newest revision read. Submit, approve, send back and publish each name one draft
 * revision. The strict reader below turns anything that is not exactly a known shape into null, so nothing malformed is
 * sent. Browser safe.
 */
import type { SupportKbDraft, SupportKbHistory, SupportKbLibrary, SupportKbTemplate } from '@intafaced/contracts';

export const KB_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const KB_LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/;
export const KB_TITLE_MAX = 200;
export const KB_BODY_MAX = 20_000;
export const KB_REASON_MAX = 500;

export type KbAuthoringRequest =
  | {
      readonly action: 'draft_save';
      readonly id: string;
      readonly title: string;
      readonly body: string;
      readonly language: string;
      readonly sectionId: string;
      readonly tags: readonly string[];
      readonly templateId: string | null;
      readonly baseRevision: number;
    }
  | { readonly action: 'submit' | 'approve' | 'publish'; readonly id: string; readonly revision: number }
  | { readonly action: 'send_back'; readonly id: string; readonly revision: number; readonly reason: string }
  | {
      readonly action: 'template_save';
      readonly id: string;
      readonly name: string;
      readonly body: string;
      readonly expectedRevision: number;
      readonly reason: string;
    };

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isId = (v: unknown): v is string => typeof v === 'string' && KB_ID.test(v.trim());
const isCount = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;
const keysAre = (raw: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(raw).every((k) => keys.includes(k)) && keys.every((k) => k in raw);

/** Labels typed in one field, separated by commas: trimmed, blanks dropped, at most 20. */
export function labelsFrom(value: string): string[] {
  return value
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export function readKbAuthoringRequest(raw: Record<string, unknown>): KbAuthoringRequest | null {
  switch (raw.action) {
    case 'draft_save': {
      if (!keysAre(raw, ['action', 'id', 'title', 'body', 'language', 'sectionId', 'tags', 'templateId', 'baseRevision'])) return null;
      if (!isId(raw.id) || !isText(raw.title, KB_TITLE_MAX) || !isText(raw.body, KB_BODY_MAX) || !isId(raw.sectionId)) return null;
      if (typeof raw.language !== 'string' || !KB_LANGUAGE.test(raw.language.trim()) || !isCount(raw.baseRevision, 0)) return null;
      if (!Array.isArray(raw.tags) || raw.tags.length > 20 || !raw.tags.every((t) => isText(t, 200))) return null;
      if (raw.templateId !== null && !isId(raw.templateId)) return null;
      return {
        action: 'draft_save',
        id: raw.id.trim(),
        title: raw.title,
        body: raw.body,
        language: raw.language.trim(),
        sectionId: raw.sectionId.trim(),
        tags: (raw.tags as string[]).map((t) => t.trim()),
        templateId: raw.templateId === null ? null : (raw.templateId as string).trim(),
        baseRevision: raw.baseRevision,
      };
    }
    case 'submit':
    case 'approve':
    case 'publish':
      return keysAre(raw, ['action', 'id', 'revision']) && isId(raw.id) && isCount(raw.revision, 1)
        ? { action: raw.action, id: raw.id.trim(), revision: raw.revision }
        : null;
    case 'send_back':
      return keysAre(raw, ['action', 'id', 'revision', 'reason']) &&
        isId(raw.id) &&
        isCount(raw.revision, 1) &&
        isText(raw.reason, KB_REASON_MAX)
        ? { action: 'send_back', id: raw.id.trim(), revision: raw.revision, reason: raw.reason.trim() }
        : null;
    case 'template_save':
      return keysAre(raw, ['action', 'id', 'name', 'body', 'expectedRevision', 'reason']) &&
        isId(raw.id) &&
        isText(raw.name, 120) &&
        isText(raw.body, KB_BODY_MAX) &&
        isCount(raw.expectedRevision, 0) &&
        isText(raw.reason, KB_REASON_MAX)
        ? {
            action: 'template_save',
            id: raw.id.trim(),
            name: raw.name.trim(),
            body: raw.body.trim(),
            expectedRevision: raw.expectedRevision,
            reason: raw.reason.trim(),
          }
        : null;
    default:
      return null;
  }
}

/** What the editor reads: each part svc-support's own answer, or the reason it is missing. */
export type KbPart<T> = { readonly kind: 'ok'; readonly data: T } | { readonly kind: 'failed'; readonly why: string };

export interface KbAuthoringView {
  readonly asOf: string;
  readonly library: KbPart<SupportKbLibrary>;
  readonly templates: KbPart<SupportKbTemplate[]>;
  /** Only when an article id was asked for. */
  readonly history: KbPart<SupportKbHistory> | null;
  /** The newest draft of that article, when its newest version is a draft. */
  readonly draft: KbPart<SupportKbDraft> | null;
}

/** The revision a new draft is saved from: the newest version of the article, 0 for an article with none. */
export function baseRevisionOf(history: SupportKbHistory | null): number {
  return history?.versions.reduce((max, v) => Math.max(max, v.revision), 0) ?? 0;
}

/** The paragraphs a reader will see, exactly as typed: the preview never renders markup. */
export function previewParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

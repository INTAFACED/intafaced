import { z } from 'zod';
import type { ApiResult } from '../../shared/api';

export type HelpSelection = { kind: 'browse' } | { kind: 'article'; id: string; version?: number } | { kind: 'invalid' };
export function helpSelection(path: string, search: string): HelpSelection {
  try {
    const raw = search.startsWith('?') ? search.slice(1) : search;
    const pairs = raw ? raw.split('&') : [];
    const values = new Map<string, string>();
    for (const pair of pairs) {
      const separator = pair.indexOf('=');
      if (separator < 0) return { kind: 'invalid' };
      const key = decodeURIComponent(pair.slice(0, separator).replace(/\+/g, ' '));
      const value = decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, ' '));
      if (!['id', 'version'].includes(key) || values.has(key)) return { kind: 'invalid' };
      values.set(key, value);
    }
    const id = values.get('id');
    if (id === undefined) return path === '/help' && !values.size ? { kind: 'browse' } : { kind: 'invalid' };
    if (!id.trim() || id.length > 200) return { kind: 'invalid' };
    const version = values.get('version');
    if (version === undefined) return { kind: 'article', id };
    if (!/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(Number(version))) return { kind: 'invalid' };
    return { kind: 'article', id, version: Number(version) };
  } catch {
    return { kind: 'invalid' };
  }
}
const generation = z.number().int().positive().safe();
export const helpArticle = z
  .object({
    id: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => Boolean(value.trim())),
    titleKey: z.string().min(1),
    bodyKey: z.string().min(1),
    published: z.boolean().optional(),
    version: generation.optional(),
    revision: generation.optional(),
    /** Text typed in the desk (SP-kb-01), shown as text. A catalogue-keyed answer has none. */
    title: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    language: z.string().min(2).optional(),
    sectionId: z.string().min(1).optional(),
  })
  .refine((article) => article.published !== false);
export type HelpArticle = z.infer<typeof helpArticle>;
export const helpVersion = (article: HelpArticle) => article.version ?? article.revision;
export function exactHelpArticle(selection: Extract<HelpSelection, { kind: 'article' }>) {
  return helpArticle
    .refine((article) => article.id === selection.id && (selection.version === undefined || helpVersion(article) === selection.version))
    .nullable();
}
export function helpWindow(limit: number) {
  return z
    .array(helpArticle)
    .max(limit)
    .refine((articles) => new Set(articles.map((article) => article.id)).size === articles.length);
}
export const helpHref = (id: string, version?: number) =>
  `/helpdetail?id=${encodeURIComponent(id)}${version === undefined ? '' : `&version=${version}`}`;
/** Actual support router maps this named exception to412, with no cause.code. */
export function missingHelpVersion(answer: ApiResult<unknown>): boolean {
  return (
    !answer.ok &&
    !answer.messageCopy &&
    answer.status === 412 &&
    answer.reason === 'error' &&
    answer.code === 'PRECONDITION_FAILED' &&
    answer.message === 'support.kb_version_unknown'
  );
}

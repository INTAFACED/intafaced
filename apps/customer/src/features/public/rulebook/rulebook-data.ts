// hand-declared-ok: svc-trade's GET /api/v1/rulebook(/versions) pass svc-matching's answer through; no contracts schema
/**
 * The published trading rulebook (RC-cex-spot-08): svc-matching's owner versions, read through svc-trade's public
 * `GET /api/v1/rulebook` (the version in force, section by section) and `GET /api/v1/rulebook/versions` (every version,
 * with the sections it changed). Signed in or not. Nothing here holds or invents rule text: unpublished is an answer.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../../shared/api';
import type { Fetcher } from '../../../data/poll';

const sectionSchema = z.object({ id: z.string().min(1), title: z.string().min(1), body: z.string() });
const upcomingSchema = z.object({ version: z.string().min(1), effectiveAt: z.string().min(1) });

export const rulebookCurrentSchema = z.union([
  z.object({
    published: z.literal(true),
    version: z.string().min(1),
    effectiveAt: z.string().min(1),
    publishedAt: z.string().min(1),
    sections: z.array(sectionSchema).min(1),
    upcoming: z.array(upcomingSchema),
  }),
  z.object({
    published: z.literal(false),
    version: z.null(),
    rejected: z.object({ code: z.string() }),
    upcoming: z.array(upcomingSchema),
  }),
]);

export const rulebookHistorySchema = z.object({
  current: z.string().nullable(),
  versions: z.array(
    z.object({
      version: z.string().min(1),
      status: z.enum(['current', 'upcoming', 'superseded']),
      effectiveAt: z.string().min(1),
      publishedAt: z.string().min(1),
      supersedes: z.string().nullable(),
      changedSections: z.array(z.string()),
      sections: z.array(sectionSchema),
    }),
  ),
});

export type RulebookCurrent = z.infer<typeof rulebookCurrentSchema>;
export type RulebookHistory = z.infer<typeof rulebookHistorySchema>;
export interface Rulebook {
  readonly current: RulebookCurrent;
  readonly history: RulebookHistory;
}

export const rulebookFetcher =
  (api: ApiClient): Fetcher<Rulebook> =>
  async (signal): Promise<ApiResult<Rulebook>> => {
    const [current, history] = await Promise.all([
      api.rest('/rulebook', rulebookCurrentSchema, { signal }),
      api.rest('/rulebook/versions', rulebookHistorySchema, { signal }),
    ]);
    if (!current.ok) return current;
    if (!history.ok) return history;
    return { ok: true, data: { current: current.data, history: history.data } };
  };

/** An ISO time as the page writes it, in UTC so every reader sees the same moment: "6 Nov 2026, 12:00 UTC". */
export function rulebookTime(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString(locale ?? 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
}

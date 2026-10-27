import { z } from 'zod';

/**
 * Wire types for the founder console's announcement banner (OPS-admin-access-08, ops-console-admin-access-035).
 *
 * An announcement is a message to every founder signed in to the console, with a kind (information, warning, error,
 * success), an optional link or dialog, and a window it shows in. It is saved as a draft first and published later; a
 * published announcement shows on every console page while its window is open. Only one shows at a time: svc-ops refuses
 * to publish one whose window overlaps another published one (`ops.banner_conflict`). Withdrawing one takes it down and
 * frees its window. This is the console's own banner for staff; announcements to customers are svc-notify's notice board.
 *
 * Browser-safe: zod only.
 */

export const ANNOUNCEMENT_KINDS = ['information', 'warning', 'error', 'success'] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

/** The window is not one svc-ops can show: it ends before it starts, or it has already ended. */
export const BANNER_WINDOW_INVALID = 'ops.banner_window_invalid' as const;
/** Another published announcement's window overlaps this one: only one shows at a time. */
export const BANNER_CONFLICT = 'ops.banner_conflict' as const;
export const ANNOUNCEMENT_NOT_FOUND = 'ops.announcement_not_found' as const;
/** A withdrawn announcement stays withdrawn: write a new one. */
export const ANNOUNCEMENT_WITHDRAWN = 'ops.announcement_withdrawn' as const;
/** svc-ops has no durable storage, so no announcement can be saved, and none shows. */
export const ANNOUNCEMENT_STORAGE_UNCONFIGURED = 'ops.announcement_storage_unconfigured' as const;

export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 500;
export const ANNOUNCEMENT_DIALOG_MAX = 4000;
export const ANNOUNCEMENT_LINK_LABEL_MAX = 60;
export const ANNOUNCEMENT_LIST_LIMIT = 50;

/** A link is an https address or a path on this console; never another scheme, never a protocol-relative `//host`. */
export const ANNOUNCEMENT_LINK = /^(?:https:\/\/[^\s"'<>]{1,2000}|\/(?![/\\])[^\s"'<>]{0,500})$/;

const iso = z.string().datetime({ offset: true });

export const announcementActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('link'),
    url: z.string().regex(ANNOUNCEMENT_LINK),
    label: z.string().trim().min(1).max(ANNOUNCEMENT_LINK_LABEL_MAX),
  }),
  z.object({ type: z.literal('dialog'), text: z.string().trim().min(1).max(ANNOUNCEMENT_DIALOG_MAX) }),
]);
export type AnnouncementAction = z.infer<typeof announcementActionSchema>;

const content = {
  kind: z.enum(ANNOUNCEMENT_KINDS),
  title: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
  body: z.string().trim().max(ANNOUNCEMENT_BODY_MAX),
  action: announcementActionSchema,
  startsAt: iso,
  endsAt: iso,
};

export const announcementSchema = z.object({
  id: z.string().uuid(),
  ...content,
  status: z.enum(['draft', 'published', 'withdrawn']),
  createdBy: z.string(),
  createdAt: iso,
  publishedBy: z.string().nullable(),
  publishedAt: iso.nullable(),
  withdrawnBy: z.string().nullable(),
  withdrawnAt: iso.nullable(),
});
export type Announcement = z.infer<typeof announcementSchema>;

/** Where an announcement stands at one instant: only `active` shows. */
export type AnnouncementPhase = 'draft' | 'scheduled' | 'active' | 'ended' | 'withdrawn';

export function announcementPhase(a: Pick<Announcement, 'status' | 'startsAt' | 'endsAt'>, at: string): AnnouncementPhase {
  if (a.status !== 'published') return a.status;
  const now = Date.parse(at);
  if (now < Date.parse(a.startsAt)) return 'scheduled';
  return now < Date.parse(a.endsAt) ? 'active' : 'ended';
}

/** Two windows overlap when each starts before the other ends (both are start-inclusive, end-exclusive). */
export const windowsOverlap = (a: Pick<Announcement, 'startsAt' | 'endsAt'>, b: Pick<Announcement, 'startsAt' | 'endsAt'>): boolean =>
  Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);

/**
 * Why a window cannot be shown, or null. A draft only needs a window that ends after it starts; publishing also needs one
 * that has not already ended.
 */
export function announcementWindowProblem(startsAt: string, endsAt: string, now: string, publishing: boolean): string | null {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'The window needs a start and an end.';
  if (end <= start) return 'The window ends before it starts.';
  if (publishing && end <= Date.parse(now)) return 'The window has already ended.';
  return null;
}

export const announcementsListOutputSchema = z.object({
  /** Newest first, drafts and withdrawn ones included, at most `ANNOUNCEMENT_LIST_LIMIT`. */
  items: z.array(announcementSchema),
  /** The one published announcement whose window is open at `asOf`, or null. */
  active: announcementSchema.nullable(),
  asOf: iso,
});
export type AnnouncementsList = z.infer<typeof announcementsListOutputSchema>;

export const announcementActiveOutputSchema = z.object({ active: announcementSchema.nullable(), asOf: iso });
export type AnnouncementActive = z.infer<typeof announcementActiveOutputSchema>;

/**
 * Save an announcement, as a draft or published at once. `key` is the business key the console derives from the founder,
 * the content and the newest announcement they saw (`announcement:<hash>`): a lost reply sent again finds the same one.
 */
export const announcementSaveInputSchema = z.object({
  key: z.string().regex(/^announcement:[0-9a-f]{16,64}$/),
  ...content,
  publish: z.boolean(),
});
export type AnnouncementSaveInput = z.infer<typeof announcementSaveInputSchema>;

export const announcementChangeInputSchema = z.object({ id: z.string().uuid(), op: z.enum(['publish', 'withdraw']) });
export type AnnouncementChangeInput = z.infer<typeof announcementChangeInputSchema>;

export const announcementWriteOutputSchema = z.object({
  announcement: announcementSchema,
  /** `created` and `changed` stored something; `replayed` found the same save already stored; `noop` found it already so. */
  outcome: z.enum(['created', 'replayed', 'changed', 'noop']),
});
export type AnnouncementWriteOutput = z.infer<typeof announcementWriteOutputSchema>;

/**
 * What svc-notify answers for its public notices (module `notify`): one notice entry as `noticeWireOutput` and
 * `changelogOutput` publish it, and the funding notices open on one asset and network (`notify.fundingNotices`). Public
 * procedures, so they work signed out. Browser-safe (zod only).
 */
import { z } from 'zod';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const NOTIFY_CHANGELOG_AREA_IDS = [
  'trading',
  'market_data',
  'account',
  'wallet',
  'payments',
  'webhooks',
  'websocket',
  'fix',
  'authentication',
] as const;

const changelogSchema = z.object({
  area: z.enum(NOTIFY_CHANGELOG_AREA_IDS),
  breaking: z.boolean(),
  endpoints: z.array(z.string()),
  scopes: z.array(z.string()),
  addedOn: day.nullable(),
  releaseOn: day.nullable(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  migrationNote: z.string().nullable(),
  retired: z.array(z.string()),
});

/** One published notice: an announcement, maintenance, incident, changelog entry or fee change. */
export const notifyNoticeEntrySchema = z.object({
  id: z.string().guid(),
  kind: z.enum(['announcement', 'maintenance', 'incident', 'changelog', 'fee_change']),
  title: z.string(),
  body: z.string(),
  status: z.enum(['draft', 'published']),
  publishedAt: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  version: z.number().int(),
  changelog: changelogSchema.nullable(),
  /** The founders' category an announcement is filed under, as filed (SP-status-03). Absent from an older svc-notify. */
  category: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  /** A changelog read in a chosen language: the language this entry's title and body are in. Absent on other reads. */
  language: z.string().optional(),
});

/** The stages a funding incident goes through, as svc-notify names them. Only the closing entry reads `resolved`. */
export const NOTIFY_FUNDING_PHASES = ['investigating', 'identified', 'update', 'monitoring', 'resolved'] as const;

/** The notice entry, with the pair and stage a funding notice carries. */
export const notifyFundingNoticeSchema = notifyNoticeEntrySchema.extend({
  asset: z.string().nullable(),
  network: z.string().nullable(),
  phase: z.enum(NOTIFY_FUNDING_PHASES).nullable(),
});

/** `notify.fundingNotices`: each open incident on this pair (its first entry and its newest), and its maintenance. */
export const notifyFundingNoticesSchema = z.object({
  asset: z.string(),
  network: z.string(),
  incidents: z.array(z.object({ root: notifyFundingNoticeSchema, latest: notifyFundingNoticeSchema })),
  maintenance: z.array(notifyFundingNoticeSchema),
});

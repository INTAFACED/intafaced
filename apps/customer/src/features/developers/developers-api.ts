// hand-declared-ok: svc-notify has no browser-safe response schema in packages/contracts; these mirror its router outputs exactly
/**
 * The developer pages' reads of svc-notify (module `notify`, tRPC through the edge). All three are public procedures, so
 * they work signed out. Shapes mirror `services/svc-notify/src/router.ts` (`statusFeedOutput`, `noticeWireOutput`,
 * `changelogOutput`); a response that does not match is refused, never shown.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';

const impact = z.enum(['none', 'minor', 'major', 'critical']);
export const STATUS_COMPONENT_IDS = ['api', 'webhooks', 'console'] as const;
const component = z.enum(STATUS_COMPONENT_IDS);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const statusFeedSchema = z.object({
  asOf: z.string(),
  components: z.array(
    z.object({
      component,
      state: z.enum(['unknown', 'maintenance', 'degraded', 'partial_outage', 'major_outage']),
      basis: z.enum(['incident', 'maintenance', 'no_measurement']),
      since: z.string().nullable(),
    }),
  ),
  incidents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      impact: impact.nullable(),
      components: z.array(component),
      openedAt: z.string(),
      resolvedAt: z.string().nullable(),
      updates: z.array(
        z.object({ id: z.string(), body: z.string(), impact: impact.nullable(), publishedAt: z.string(), resolves: z.boolean() }),
      ),
    }),
  ),
  maintenance: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      components: z.array(component),
      startsAt: z.string().nullable(),
      endsAt: z.string().nullable(),
    }),
  ),
  history: z.object({
    basis: z.literal('incident_notices_only'),
    days: z.array(
      z.object({
        date: z.string(),
        components: z.array(z.object({ component, incidentMinutes: z.number().int().min(0), worstImpact: impact.nullable() })),
      }),
    ),
  }),
});
export type StatusFeed = z.infer<typeof statusFeedSchema>;

export const CHANGELOG_AREA_IDS = [
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
export type ChangelogAreaId = (typeof CHANGELOG_AREA_IDS)[number];

const changelogSchema = z.object({
  area: z.enum(CHANGELOG_AREA_IDS),
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
export const entrySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['announcement', 'maintenance', 'incident', 'changelog']),
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
});
export type ChangelogEntry = z.infer<typeof entrySchema>;

const upcomingSchema = z.object({
  upcoming: z.array(entrySchema),
  retired: z.array(z.object({ endpoint: z.string(), entryId: z.string().uuid(), title: z.string(), releaseOn: day.nullable() })),
});
export type UpcomingChanges = z.infer<typeof upcomingSchema>;

export const readStatusFeed = (api: ApiClient, signal?: AbortSignal): Promise<ApiResult<StatusFeed>> =>
  api.query('notify', 'notify.statusFeed', { days: 30 }, statusFeedSchema, { signal });

export const readChangelog = (
  api: ApiClient,
  filter: { area: ChangelogAreaId | null; breaking: boolean },
  signal?: AbortSignal,
): Promise<ApiResult<ChangelogEntry[]>> =>
  api.query(
    'notify',
    'notify.changelog',
    { limit: 50, ...(filter.area ? { area: filter.area } : {}), ...(filter.breaking ? { breaking: true } : {}) },
    z.array(entrySchema).max(50),
    { signal },
  );

export const readUpcomingChanges = (api: ApiClient, signal?: AbortSignal): Promise<ApiResult<UpcomingChanges>> =>
  api.query('notify', 'notify.upcomingChanges', undefined, upcomingSchema, { signal });

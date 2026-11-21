// hand-declared-ok: svc-notify has no browser-safe response schema in packages/contracts; these mirror its router outputs exactly
/**
 * The reads of svc-notify shared by the developer pages, the public notices and status pages, funding notices and risk control (module `notify`, tRPC through the edge). All three are public procedures, so
 * they work signed out. Shapes mirror `services/svc-notify/src/router.ts` (`statusFeedOutput`, `noticeWireOutput`,
 * `changelogOutput`); a response that does not match is refused, never shown.
 */
import { z } from 'zod';
import { NOTIFY_CHANGELOG_AREA_IDS, notifyNoticeEntrySchema as entrySchema } from '@intafaced/contracts/notify-public-notices';
import type { ApiClient, ApiResult } from './api';
import { NOTIFY_STATUS_FEED, NOTIFY_CHANGELOG, NOTIFY_UPCOMING_CHANGES } from '@intafaced/contracts/notify-notify-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

const impact = z.enum(['none', 'minor', 'major', 'critical']);
export const STATUS_COMPONENT_IDS = ['api', 'webhooks', 'console'] as const;
const component = z.enum(STATUS_COMPONENT_IDS);

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
export type StatusFeed = ProcedureOutput<typeof NOTIFY_STATUS_FEED>;

/** One notice entry and the changelog's areas, from `@intafaced/contracts/notify-public-notices`. */
export { NOTIFY_CHANGELOG_AREA_IDS as CHANGELOG_AREA_IDS, entrySchema };
export type ChangelogAreaId = (typeof NOTIFY_CHANGELOG_AREA_IDS)[number];
export type ChangelogEntry = z.infer<typeof entrySchema>;

export type UpcomingChanges = ProcedureOutput<typeof NOTIFY_UPCOMING_CHANGES>;

export const readStatusFeed = (api: ApiClient, signal?: AbortSignal): Promise<ApiResult<StatusFeed>> =>
  api.call(NOTIFY_STATUS_FEED, { days: 30 }, { signal });

/** The changelog in the reader's chosen language (`language`, the app's locale code): each entry names the language it is in. */
export const readChangelog = (
  api: ApiClient,
  filter: { area: ChangelogAreaId | null; breaking: boolean },
  language: string,
  signal?: AbortSignal,
): Promise<ApiResult<ChangelogEntry[]>> =>
  api.call(
    NOTIFY_CHANGELOG,
    { limit: 50, language, ...(filter.area ? { area: filter.area } : {}), ...(filter.breaking ? { breaking: true } : {}) },
    { signal },
  );

export const readUpcomingChanges = (api: ApiClient, language: string, signal?: AbortSignal): Promise<ApiResult<UpcomingChanges>> =>
  api.call(NOTIFY_UPCOMING_CHANGES, { language }, { signal });

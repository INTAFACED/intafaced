import { z } from 'zod';

/**
 * SP-status-01: public status page, owned by svc-notify (ENGINE ST-1 to ST-4).
 * A component's status comes from a reading its owning service publishes; a missing reading, or one older than the
 * owner's staleness window (blank = every reading stale), is `no_data`, never operational. Uptime comes only from
 * stored samples; percentages are basis points (integers). Cap, staleness and sampling are blank owner values.
 */
export const STATUS_COMPONENT_CAP_UNSET = 'status.component_cap_unset' as const;
export const STATUS_STALENESS_UNSET = 'status.staleness_unset' as const;
export const STATUS_SAMPLING_UNSET = 'status.sampling_unset' as const;
export const STATUS_COMPONENT_UNKNOWN = 'status.component_unknown' as const;
export const statusPageErrorCodeSchema = z.enum([
  STATUS_COMPONENT_CAP_UNSET,
  STATUS_STALENESS_UNSET,
  STATUS_SAMPLING_UNSET,
  STATUS_COMPONENT_UNKNOWN,
]);
export type StatusPageErrorCode = z.infer<typeof statusPageErrorCodeSchema>;

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const name = z.string().trim().min(1).max(120);

/** ST-1. */
export const statusComponentStatusSchema = z.enum([
  'operational',
  'degraded_performance',
  'partial_outage',
  'major_outage',
  'under_maintenance',
  'no_data',
]);
export type StatusComponentStatus = z.infer<typeof statusComponentStatusSchema>;

/** A reading as an owning service publishes it; `no_data` is derived here, never published. */
export const statusReadingSchema = z
  .object({ status: statusComponentStatusSchema.exclude(['no_data']), observedAt: timestamp, source: z.string().trim().min(1).max(80) })
  .strict();
export type StatusReading = z.infer<typeof statusReadingSchema>;

export const statusComponentSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('service'), service: z.string().regex(/^svc-[a-z0-9-]{1,40}$/) }).strict(),
  z.object({ kind: z.literal('third_party'), label: name }).strict(),
]);

export const statusComponentSchema = z
  .object({
    componentId: id,
    groupId: id.nullable(),
    name,
    source: statusComponentSourceSchema,
    status: statusComponentStatusSchema,
    reading: statusReadingSchema.nullable(),
  })
  .strict()
  .refine((c) => c.reading !== null || c.status === 'no_data', { path: ['status'], message: 'No reading means no_data' });
export type StatusComponent = z.infer<typeof statusComponentSchema>;

export const statusGroupSchema = z.object({ groupId: id, name, order: z.number().int().nonnegative().safe() }).strict();

/** Top level: `none` when no component is defined (the page says so, no green banner). */
export const statusTopLevelSchema = z.union([statusComponentStatusSchema, z.literal('none')]);
export type StatusTopLevel = z.infer<typeof statusTopLevelSchema>;

const SEVERITY: readonly StatusComponentStatus[] = ['operational', 'no_data', 'degraded_performance', 'partial_outage', 'major_outage'];

/** ST-2: most severe non-maintenance status; maintenance only when every component is under maintenance. */
export function statusTopLevel(statuses: readonly StatusComponentStatus[]): StatusTopLevel {
  if (statuses.length === 0) return 'none';
  const active = statuses.filter((s) => s !== 'under_maintenance');
  if (active.length === 0) return 'under_maintenance';
  return active.reduce((worst, s) => (SEVERITY.indexOf(s) > SEVERITY.indexOf(worst) ? s : worst), 'operational' as StatusComponentStatus);
}

/** ST-2: a reading counts only if fresh; blank staleness (null) means every reading is stale. */
export function statusFromReading(reading: StatusReading | null, now: Date, stalenessSeconds: number | null): StatusComponentStatus {
  if (reading === null || stalenessSeconds === null) return 'no_data';
  const age = now.getTime() - Date.parse(reading.observedAt);
  return age >= 0 && age <= stalenessSeconds * 1000 ? reading.status : 'no_data';
}

export const statusComponentsListSchema = z
  .object({
    topLevel: statusTopLevelSchema,
    groups: z.array(statusGroupSchema),
    components: z.array(statusComponentSchema),
    readAt: timestamp,
  })
  .strict()
  .refine((page) => page.topLevel === statusTopLevel(page.components.map((c) => c.status)), {
    path: ['topLevel'],
    message: 'Top level must follow ST-2',
  });
export type StatusComponentsList = z.infer<typeof statusComponentsListSchema>;

export const statusUptimeSeriesInputSchema = z.object({ componentId: id, from: timestamp, to: timestamp }).strict();

/** ST-3: counts and basis points only; no samples means no percentage. */
export const statusUptimeSeriesSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('sampling_unset'), code: z.literal(STATUS_SAMPLING_UNSET) }).strict(),
  z
    .object({
      status: z.literal('sampled'),
      componentId: id,
      buckets: z.array(
        z
          .object({
            start: timestamp,
            samples: z.number().int().nonnegative().safe(),
            operational: z.number().int().nonnegative().safe(),
            uptimeBps: z.number().int().min(0).max(10_000).nullable(),
          })
          .strict()
          .refine((b) => b.operational <= b.samples && (b.samples === 0) === (b.uptimeBps === null), {
            message: 'Uptime only from samples',
          }),
      ),
    })
    .strict(),
]);
export type StatusUptimeSeries = z.infer<typeof statusUptimeSeriesSchema>;

/** Founder-ops define (audited by the service); carries a revision. */
export const statusComponentDefineInputSchema = z
  .object({
    componentId: id.nullable(),
    expectedRevision: z.number().int().nonnegative().safe(),
    groupId: id.nullable(),
    name,
    source: statusComponentSourceSchema,
  })
  .strict();
export type StatusComponentDefineInput = z.infer<typeof statusComponentDefineInputSchema>;

/** Manual reading for a third-party component: source label and time required; it goes stale like any reading. */
export const statusThirdPartyEntryInputSchema = z
  .object({ componentId: id, expectedRevision: z.number().int().nonnegative().safe(), reading: statusReadingSchema })
  .strict();
export type StatusThirdPartyEntryInput = z.infer<typeof statusThirdPartyEntryInputSchema>;

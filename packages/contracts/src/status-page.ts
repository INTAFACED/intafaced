/**
 * Public status page contract (SP-status-01): the components the founders define, the readings that give each one a
 * state, and the page a signed-out visitor reads at /status.
 *
 * - A component's state comes only from a reading (a health record with its source and time) or from a published incident
 *   or maintenance notice that names it. Nothing is typed in as "operational": a component with no reading, or a reading
 *   older than the staleness window, reads `no_data`, and the top level is then not operational.
 * - Three owner values decide the page and are blank until a founder sets them: the component cap (blank refuses every
 *   definition, `status.component_cap_unset`), the staleness window (blank shows every reading as no data,
 *   `status.staleness_unset`) and the uptime window in days (blank shows no strip, `status.uptime_window_unset`).
 * - The uptime strip is built from stored readings only: a day with none is empty. No percentage is made, because nothing
 *   samples a component on a clock.
 *
 * Browser safe: nothing here imports Node. Names, states and times are public by design; no host name or error text is.
 */
import { z } from 'zod';

export const STATUS_PAGE_ERROR_CODES = [
  'status.component_cap_unset',
  'status.component_cap_reached',
  'status.component_unknown',
  'status.reading_in_future',
  'status.reading_conflict',
  'status.page_revision_stale',
] as const;
export type StatusPageErrorCode = (typeof STATUS_PAGE_ERROR_CODES)[number];

/** What a reading may say. `maintenance` is a reading too: a source can report planned work. */
export const STATUS_READING_STATES = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'] as const;
export type StatusReadingState = (typeof STATUS_READING_STATES)[number];

/** What the page shows for a component and for the top level: a reading state, or no data. */
export const STATUS_PAGE_STATES = [...STATUS_READING_STATES, 'no_data'] as const;
export type StatusPageState = (typeof STATUS_PAGE_STATES)[number];

/**
 * Worst first. A component nobody can read outranks maintenance and operational, so one silent component keeps the top
 * level from reading operational, while a real outage elsewhere still shows as the outage.
 */
export const STATUS_PAGE_SEVERITY: Readonly<Record<StatusPageState, number>> = {
  major_outage: 5,
  partial_outage: 4,
  degraded: 3,
  no_data: 2,
  maintenance: 1,
  operational: 0,
};

/** Why a component shows what it shows. */
export const STATUS_COMPONENT_BASES = ['incident', 'maintenance', 'reading', 'no_reading', 'stale', 'staleness_unset'] as const;
export type StatusComponentBasis = (typeof STATUS_COMPONENT_BASES)[number];

export const STATUS_COMPONENT_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const STATUS_COMPONENTS_MAX = 100;
export const STATUS_STALENESS_SECONDS_MAX = 7 * 86_400;
export const STATUS_UPTIME_DAYS_MAX = 90;
export const STATUS_PAGE_REASON_MAX = 500;

const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.string().datetime({ offset: true });

export const statusComponentIdSchema = z.string().regex(STATUS_COMPONENT_ID);

/** One component as the founders define it. `source` names an outside dependency whose readings a founder enters by hand. */
export const statusComponentDefinitionSchema = z
  .object({
    id: statusComponentIdSchema,
    name: text(80),
    group: text(80).nullable(),
    source: text(80).nullable(),
  })
  .strict();
export type StatusComponentDefinition = z.infer<typeof statusComponentDefinitionSchema>;

const ownerValue = (max: number) => z.number().int().min(1).max(max).nullable();

/**
 * Define the page: the components (the whole list, in display order, replacing the previous one) and the owner values. A
 * field left out is unchanged; `null` clears an owner value. `expectedRevision` is the revision the founder read.
 */
export const statusPageConfigureInputSchema = z
  .object({
    components: z.array(statusComponentDefinitionSchema).max(STATUS_COMPONENTS_MAX).optional(),
    componentCap: ownerValue(STATUS_COMPONENTS_MAX).optional(),
    stalenessSeconds: ownerValue(STATUS_STALENESS_SECONDS_MAX).optional(),
    uptimeDays: ownerValue(STATUS_UPTIME_DAYS_MAX).optional(),
    /** Subscriptions (SP-status-04): proof-of-work strength in leading zero bits, and subscribe requests per address per hour. */
    challengeBits: ownerValue(32).optional(),
    subscribeRatePerHour: ownerValue(1000).optional(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    reason: text(STATUS_PAGE_REASON_MAX),
  })
  .strict()
  .refine((input) => new Set((input.components ?? []).map((c) => c.id)).size === (input.components ?? []).length, {
    message: 'status.component_duplicate',
  });
export type StatusPageConfigureInput = z.infer<typeof statusPageConfigureInputSchema>;

/**
 * One reading of one component at one instant, from a named source. The same component and instant is one reading: a
 * replay of the same reading is a no-op, a different state at the same instant is `status.reading_conflict`.
 */
export const statusReadingInputSchema = z
  .object({
    componentId: statusComponentIdSchema,
    state: z.enum(STATUS_READING_STATES),
    observedAt: instant,
    source: text(80),
  })
  .strict();
export type StatusReadingInput = z.infer<typeof statusReadingInputSchema>;

export const statusPageSettingsSchema = z
  .object({
    componentCap: z.number().int().nullable(),
    stalenessSeconds: z.number().int().nullable(),
    uptimeDays: z.number().int().nullable(),
    challengeBits: z.number().int().nullable(),
    subscribeRatePerHour: z.number().int().nullable(),
  })
  .strict();
export type StatusPageSettings = z.infer<typeof statusPageSettingsSchema>;

const incidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  impact: z.enum(['none', 'minor', 'major', 'critical']).nullable(),
  /** Only components on this page; a notice may also name components the page does not define. */
  components: z.array(z.string()),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
  updates: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      impact: z.enum(['none', 'minor', 'major', 'critical']).nullable(),
      publishedAt: z.string(),
      resolves: z.boolean(),
    }),
  ),
});

export const statusPageSchema = z
  .object({
    asOf: z.string(),
    revision: z.number().int().min(0),
    settings: statusPageSettingsSchema,
    /** `none_defined` when the founders have defined no component: the page shows no banner at all. */
    overall: z.union([z.enum(STATUS_PAGE_STATES), z.literal('none_defined')]),
    components: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        group: z.string().nullable(),
        source: z.string().nullable(),
        state: z.enum(STATUS_PAGE_STATES),
        basis: z.enum(STATUS_COMPONENT_BASES),
        /** The reading the state rests on (or the stale one it ignored), else null. */
        reading: z.object({ state: z.enum(STATUS_READING_STATES), observedAt: z.string(), source: z.string() }).nullable(),
        /** The open incident that sets the state, else null. */
        incidentId: z.string().nullable(),
        /** One entry per day of the uptime window, oldest first: the worst reading that day, or null for none. Empty when the window is not set. */
        uptime: z.array(z.object({ date: z.string(), state: z.enum(STATUS_READING_STATES).nullable() })),
      }),
    ),
    /** Open incidents first, then those resolved inside the window, newest first. */
    incidents: z.array(incidentSchema),
  })
  .strict();
export type StatusPage = z.infer<typeof statusPageSchema>;

/** The key a definition change is logged under: the revision it moves from, so a lost reply replays instead of applying twice. */
export function statusPageConfigureKey(expectedRevision: number): string {
  return `status.page:r${expectedRevision}`;
}

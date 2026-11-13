/**
 * The account's chart templates (`charts.templates`, C-embed-feed-ops-03 / charts-desk-embed-feed-ops-017, J-charts-desk-07
 * #6): a named set of studies (the indicators with their inputs, colours and panes), the chart's style and the drawings on
 * the chart it was saved on, applied to any other symbol or workbench. A drawing is anchored to one market's prices and
 * times, so a template keeps its drawings with that market: they are placed where the template is applied on that market,
 * and kept, not placed, on any other.
 *
 * Kept through the identity preferences door (compare-and-set on `version`) so templates follow the person to every
 * device; C-workspace-02 owns the door. A view record only: a template never places an order or changes a balance.
 */
import { z } from 'zod';

export const CHART_TEMPLATES_NAMESPACE = 'charts.templates' as const;

/** Fixed guards against a runaway write. Not owner limits: a name over 40 characters is refused, as the spec says. */
export const CHART_TEMPLATES_HARD_MAX = 50;
export const CHART_TEMPLATE_STUDIES_MAX = 25;
export const CHART_TEMPLATE_NAME_MAX = 40;
export const CHART_TEMPLATE_DRAWINGS_MAX = 100;
export const CHART_TEMPLATE_DRAWING_POINTS_MAX = 500;

const id = z.string().regex(/^[a-z0-9][a-z0-9:-]{0,63}$/, 'id');
const token = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'token');
const interval = z.string().regex(/^[0-9]{1,2}[mhdw]$/, 'interval');

/** One study as the chart keeps it: its kind, the inputs as typed, its colour and the intervals it is hidden on. */
export const templateStudySchema = z
  .object({
    id,
    kind: token,
    inputs: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/), z.string().max(32)),
    color: token,
    hiddenOn: z.array(interval).max(12),
  })
  .strict();

export const templatePanesSchema = z
  .object({
    onMain: z.array(id).max(CHART_TEMPLATE_STUDIES_MAX),
    collapsed: z.array(id).max(CHART_TEMPLATE_STUDIES_MAX),
    sizes: z.record(id, z.number().min(0.25).max(4)),
    maximised: id.nullable(),
  })
  .strict();

const decimal = z.string().regex(/^-?\d{1,20}(\.\d{1,18})?$/, 'decimal');
const symbol = z.string().regex(/^[A-Za-z0-9._-]{1,32}\/[A-Za-z0-9._:-]{1,32}$/, 'symbol');

/** One drawing as the chart keeps it: by bar time (epoch seconds) and decimal price, never by pixel. */
export const templateDrawingSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/, 'id'),
    kind: z.string().regex(/^[a-zA-Z]{1,24}$/, 'kind'),
    points: z
      .array(z.object({ time: z.number().int().nonnegative(), price: decimal }).strict())
      .min(1)
      .max(CHART_TEMPLATE_DRAWING_POINTS_MAX),
    variant: z.enum(['abcd', 'xabcd']).optional(),
    text: z.string().max(200).optional(),
    size: z.number().int().min(8).max(64).optional(),
    tone: token,
    pane: z.number().int().min(1).max(12).optional(),
    levels: z.array(decimal).max(24).optional(),
    locked: z.boolean(),
    hidden: z.boolean(),
  })
  .strict();

/** The drawings on the chart a template was saved on, with the market they belong to. */
export const templateDrawingsSchema = z
  .object({ symbol, items: z.array(templateDrawingSchema).max(CHART_TEMPLATE_DRAWINGS_MAX) })
  .strict()
  .refine((drawings) => new Set(drawings.items.map((item) => item.id)).size === drawings.items.length, 'each drawing id once');

export const chartTemplateSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(CHART_TEMPLATE_NAME_MAX),
    studies: z.array(templateStudySchema).max(CHART_TEMPLATE_STUDIES_MAX),
    panes: templatePanesSchema.optional(),
    legendAlways: z.boolean(),
    /** The chart style and colour scheme it was saved with. */
    style: token,
    scheme: token,
    /** Absent on a template saved before drawings were kept, or from a chart with none. */
    drawings: templateDrawingsSchema.optional(),
    savedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((template) => new Set(template.studies.map((study) => study.id)).size === template.studies.length, 'each study id once');
export type ChartTemplate = z.infer<typeof chartTemplateSchema>;

export const chartTemplatesValueSchema = z
  .object({ templates: z.array(chartTemplateSchema).max(CHART_TEMPLATES_HARD_MAX) })
  .strict()
  .refine((value) => new Set(value.templates.map((template) => template.id)).size === value.templates.length, 'each template id once')
  .refine(
    (value) => new Set(value.templates.map((template) => template.name.toLowerCase())).size === value.templates.length,
    'each template name once',
  );
export type ChartTemplatesValue = z.infer<typeof chartTemplatesValueSchema>;

export const chartTemplatesPreferenceSchema = z
  .object({ namespace: z.literal(CHART_TEMPLATES_NAMESPACE), version: z.number().int(), value: chartTemplatesValueSchema.nullable() })
  .strict();
export type ChartTemplatesPreference = z.infer<typeof chartTemplatesPreferenceSchema>;

export const EMPTY_CHART_TEMPLATES: ChartTemplatesValue = { templates: [] };

/** The client request id of a write: a business key per (person, version read, value written), never random. */
export function chartTemplatesRequestId(userId: string, ifVersion: number, value: unknown): string {
  return `${CHART_TEMPLATES_NAMESPACE}:${userId.toLowerCase()}:${ifVersion}:${digest(JSON.stringify(value))}`;
}

/** A short, stable digest (FNV-1a, 64 bits). */
function digest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

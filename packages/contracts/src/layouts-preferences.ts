/**
 * The chart desk's saved layouts (`trade.layouts`), saved chart templates (`trade.chart-templates`), and the desk's widget set
 * inside a layout. C-workspace-02 and C-embed-feed-ops-03. Both namespaces are per-person account records, read and written
 * through the identity preferences door (`preferences.get` / `preferences.set`, compare-and-set on `version`).
 *
 * View settings only: a layout or a template never places an order, never changes a price or a balance, and never carries
 * candles (a layout's export is its settings). The owner's limits (layouts per person, the restore window and the restore
 * list, templates per person) are checked by identity; a blank limit refuses the write that needs it, and nothing here
 * invents one.
 */
import { z } from 'zod';

export const LAYOUTS_NAMESPACE = 'trade.layouts' as const;
export const CHART_TEMPLATES_NAMESPACE = 'trade.chart-templates' as const;

/** The two desk presets. Classic is the simple desk; Advanced is the pro desk, which also shows the studies bar and the drawing tools. */
export const DESK_PRESETS = ['classic', 'advanced'] as const;
export const DESK_SIDES = ['right', 'left'] as const;
export const CHART_LAYOUT_IDS = ['single', 'two-across', 'two-down', 'grid'] as const;
export const CHART_GROUP_IDS = ['blue', 'green', 'orange'] as const;

/** Hard guards against a runaway write, whatever the owner's limits are. */
export const LAYOUT_MAX_BYTES = 96 * 1024;
export const LAYOUT_RECORD_MAX = 50;
export const LAYOUT_DELETED_MAX = 100;
export const TEMPLATE_RECORD_MAX = 20;
export const LAYOUT_NAME_MAX = 60;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'id');
const pair = z.string().regex(/^[A-Za-z0-9._-]{1,32}\/[A-Za-z0-9._:-]{1,32}$/, 'symbol');
const interval = z.string().regex(/^(?:[0-9]{1,2}[mh]|[0-9]{1,2}[dwM]|1d|1w)$/, 'interval');
const chartStyle = z.string().regex(/^[a-z-]{1,24}$/, 'chart style');
const scheme = z.enum(['standard', 'inverted', 'mono']);
const name = z.string().trim().min(1).max(LAYOUT_NAME_MAX);
const isoTime = z.string().datetime({ offset: true });

/** Which widgets the desk shows: the preset it was set from, the side the watchlist sits on, and the two Advanced parts. */
export const deskSettingSchema = z
  .object({
    preset: z.enum(DESK_PRESETS),
    side: z.enum(DESK_SIDES),
    studies: z.boolean(),
    drawings: z.boolean(),
  })
  .strict();
export type DeskSetting = z.infer<typeof deskSettingSchema>;

const weight = z.number().min(0.2).max(5);
export const gridSnapshotSchema = z
  .object({
    layout: z.enum(CHART_LAYOUT_IDS),
    sync: z.object({ symbol: z.boolean(), interval: z.boolean(), crosshair: z.boolean(), range: z.boolean() }).strict(),
    cells: z
      .array(
        z
          .object({
            symbol: pair,
            interval,
            mode: chartStyle,
            group: z.enum(CHART_GROUP_IDS).nullable(),
          })
          .strict(),
      )
      .max(3),
    sizes: z.object({ cols: z.tuple([weight, weight]), rows: z.tuple([weight, weight]) }).strict(),
  })
  .strict();

/**
 * Studies and drawings are the workbench's own stored shapes (a study store per chart slot, a drawing document per symbol).
 * The customer checks their shape when it opens a layout; here they are bounded JSON, so the record stays small.
 */
export const layoutSnapshotSchema = z
  .object({
    symbol: pair,
    interval,
    mode: chartStyle,
    scheme,
    desk: deskSettingSchema,
    firstGroup: z.enum([...CHART_GROUP_IDS, 'none']),
    grid: gridSnapshotSchema,
    studies: z.array(z.unknown()).max(4),
    drawings: z.unknown(),
  })
  .strict();
export type LayoutSnapshot = z.infer<typeof layoutSnapshotSchema>;

export const savedLayoutSchema = z.object({ id, name, savedAt: isoTime, snapshot: layoutSnapshotSchema }).strict();
export type SavedLayout = z.infer<typeof savedLayoutSchema>;

export const deletedLayoutSchema = z.object({ layout: savedLayoutSchema, deletedAt: isoTime }).strict();
export type DeletedLayout = z.infer<typeof deletedLayoutSchema>;

/** The record: the person's layouts, and the deleted ones kept for the restore window (newest first). */
export const layoutsValueSchema = z
  .object({
    layouts: z.array(savedLayoutSchema).max(LAYOUT_RECORD_MAX),
    deleted: z.array(deletedLayoutSchema).max(LAYOUT_DELETED_MAX),
  })
  .strict()
  .refine((value) => new Set(value.layouts.map((layout) => layout.id)).size === value.layouts.length, 'each layout id once');
export type LayoutsValue = z.infer<typeof layoutsValueSchema>;
export const NO_LAYOUTS: LayoutsValue = { layouts: [], deleted: [] };

export const layoutsPreferenceSchema = z
  .object({ namespace: z.literal(LAYOUTS_NAMESPACE), version: z.number().int(), value: layoutsValueSchema.nullable() })
  .strict();

/** A chart template: its study set and drawings, the interval and style it opens with. Applied to any market. */
export const chartTemplateSchema = z
  .object({
    id,
    name,
    savedAt: isoTime,
    /** The market the template was saved on. Its drawings are drawn at that market's prices, so they apply only there. */
    symbol: pair,
    interval,
    mode: chartStyle,
    studies: z.array(z.unknown()).max(1),
    drawings: z.unknown(),
  })
  .strict();
export type ChartTemplate = z.infer<typeof chartTemplateSchema>;

export const chartTemplatesValueSchema = z
  .array(chartTemplateSchema)
  .max(TEMPLATE_RECORD_MAX)
  .refine((templates) => new Set(templates.map((template) => template.id)).size === templates.length, 'each template id once');
export type ChartTemplatesValue = z.infer<typeof chartTemplatesValueSchema>;

export const chartTemplatesPreferenceSchema = z
  .object({ namespace: z.literal(CHART_TEMPLATES_NAMESPACE), version: z.number().int(), value: chartTemplatesValueSchema.nullable() })
  .strict();

/** A 64-bit FNV-1a digest of a text, as hex, so a business key stays short (the same digest the watchlists use). */
function digest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * The client request id of a write: a business key, never random. One id per (person, version read, record written), so a
 * retry after a lost reply returns the first stored result, and another device's different write at the same version
 * meets a version conflict instead.
 */
export function layoutsRequestId(userId: string, ifVersion: number, value: LayoutsValue): string {
  return `layouts:${userId.toLowerCase()}:${ifVersion}:${digest(JSON.stringify(value))}`;
}
export function chartTemplatesRequestId(userId: string, ifVersion: number, value: ChartTemplatesValue): string {
  return `chart-templates:${userId.toLowerCase()}:${ifVersion}:${digest(JSON.stringify(value))}`;
}

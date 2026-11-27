/**
 * The account's saved desk layouts (`trade.desk.layouts`, C-workspace-02, J-charts-desk-07 #3 to #5): named layouts with
 * the symbol and chart interval they were saved on, the one in use (autosaved into as the person changes the desk), the
 * recently deleted ones that can still be restored, and the layout each desk opens on by default.
 *
 * A layout's `desk` is one of two versions:
 * - v1, today's spot desk: its fixed widget set, order and widths;
 * - v2, a free-form workspace: a list of panels, each with a type from an open registry (a type no screen knows yet is
 *   kept, never dropped), its own settings and a position and size on a grid.
 * `readDeskWorkspace` is the one migration: it reads either version as v2 and leaves the stored value as it is, so a
 * stored v1 layout loads unchanged; `legacyDeskOf` gives a v2 workspace back as v1 when today's desk can draw it.
 *
 * Kept through the identity preferences door (`preferences.get` / `preferences.set`, compare-and-set on `version`) so they
 * follow the person to every device. The owner's limits (layouts per account, how many deleted layouts are kept and for
 * how many days) are checked by identity against its own settings; a blank limit refuses the write that needs it, never a
 * default. A view record only: a layout never places an order or changes a balance.
 */
import { z } from 'zod';

export const DESK_LAYOUTS_NAMESPACE = 'trade.desk.layouts' as const;

/** Fixed guards against a runaway write, whatever the owner's limits are. Not owner limits. */
export const DESK_LAYOUTS_HARD_MAX = 100;
export const DESK_LAYOUTS_DELETED_HARD_MAX = 200;
export const DESK_DEFAULTS_HARD_MAX = 32;

export const DESK_WIDGET_IDS = ['markets', 'chart', 'book', 'trades'] as const;
export const DESK_PRESET_IDS = ['classic', 'advanced'] as const;
/** The chart intervals a layout may name: the desk chart's own list. */
export const DESK_LAYOUT_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'] as const;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'id');
const symbol = z.string().regex(/^[A-Za-z0-9._-]{1,32}\/[A-Za-z0-9._:-]{1,32}$/, 'symbol');
const at = z.string().datetime({ offset: true });

/** The colour groups a desk panel may join. Names, not colours: the screen draws each from the kit's tokens. */
export const DESK_LINK_COLOURS = ['red', 'green', 'blue', 'amber'] as const;
export type DeskLinkColour = (typeof DESK_LINK_COLOURS)[number];
/** The market kinds a link group may carry: the venue door's own. */
export const DESK_LINK_MARKET_KINDS = ['spot', 'perpetual'] as const;

const colour = z.enum(DESK_LINK_COLOURS);

/** What a link group carries: the market every member shows. A perpetual's symbol may be its base alone. */
export const deskLinkContextSchema = z
  .object({
    symbol: z.string().regex(/^[A-Za-z0-9._:-]{1,32}(\/[A-Za-z0-9._:-]{1,32})?$/, 'symbol'),
    venue: id,
    kind: z.enum(DESK_LINK_MARKET_KINDS),
  })
  .strict();
export type DeskLinkContext = z.infer<typeof deskLinkContextSchema>;

/**
 * Panel link groups: each panel may join one colour group, and each group carries one market; a change in one
 * member reaches every member of its group and none outside it (`apps/customer/src/screens/trade/desk/link-groups.ts`).
 * Saved with the layout; the server only stores it.
 */
export const deskLinksSchema = z
  .object({
    members: z
      .object({ markets: colour.optional(), chart: colour.optional(), book: colour.optional(), trades: colour.optional() })
      .strict(),
    groups: z
      .object({
        red: deskLinkContextSchema.optional(),
        green: deskLinkContextSchema.optional(),
        blue: deskLinkContextSchema.optional(),
        amber: deskLinkContextSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (links) =>
      DESK_WIDGET_IDS.every((panel) => {
        const name = links.members[panel];
        return name === undefined || links.groups[name] !== undefined;
      }),
    "each member's group carries a market",
  )
  .refine(
    (links) =>
      DESK_LINK_COLOURS.every((name) => links.groups[name] === undefined || DESK_WIDGET_IDS.some((panel) => links.members[panel] === name)),
    'each group has a member',
  );
export type DeskLinks = z.infer<typeof deskLinksSchema>;

/** The desk's widget workspace, as `apps/customer/src/screens/trade/desk/workspace.ts` draws it. Widths are rem. */
export const deskWorkspaceV1Schema = z
  .object({
    v: z.literal(1),
    preset: z.enum(DESK_PRESET_IDS),
    order: z.array(z.enum(DESK_WIDGET_IDS)).min(1).max(DESK_WIDGET_IDS.length),
    widths: z
      .object({
        markets: z.number().min(10).max(32).optional(),
        book: z.number().min(10).max(32).optional(),
        trades: z.number().min(10).max(32).optional(),
      })
      .strict(),
    links: deskLinksSchema.optional(),
  })
  .strict()
  .refine((desk) => new Set(desk.order).size === desk.order.length, 'each widget once')
  .refine(
    (desk) => DESK_WIDGET_IDS.every((panel) => desk.links?.members[panel] === undefined || desk.order.includes(panel)),
    'a linked panel is on the desk',
  );

export type DeskWorkspaceV1 = z.infer<typeof deskWorkspaceV1Schema>;

/** The panel types today's screens know. The registry is open: a stored panel of any other well-formed type is kept. */
export const DESK_PANEL_TYPES = ['chart', 'order-entry', 'positions', 'orders', 'watchlist', 'depth', 'tape', 'news'] as const;
export type KnownDeskPanelType = (typeof DESK_PANEL_TYPES)[number];
export const isKnownPanelType = (type: string): type is KnownDeskPanelType => DESK_PANEL_TYPES.some((known) => known === type);

/** The grid: a fixed number of columns, rows growing downwards. Fixed guards, not owner limits. */
export const DESK_GRID_COLUMNS = 24;
export const DESK_GRID_ROWS_MAX = 512;
export const DESK_PANELS_HARD_MAX = 32;
/** A panel's settings, written as JSON, stay under this many characters. */
export const DESK_PANEL_SETTINGS_MAX_CHARS = 4096;

/** One setting value: JSON. */
export type DeskPanelSetting = string | number | boolean | null | DeskPanelSetting[] | { [key: string]: DeskPanelSetting };
const panelSetting: z.ZodType<DeskPanelSetting> = z.lazy(() =>
  z.union([
    z.string().max(DESK_PANEL_SETTINGS_MAX_CHARS),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(panelSetting).max(256),
    z.record(z.string().max(64), panelSetting),
  ]),
);

const panelType = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/, 'panel type');
const cell = z.number().int();

export const deskPanelSchema = z
  .object({
    id,
    type: panelType,
    settings: z
      .record(z.string().max(64), panelSetting)
      .refine((settings) => JSON.stringify(settings).length <= DESK_PANEL_SETTINGS_MAX_CHARS, 'settings too large'),
    grid: z
      .object({
        x: cell.min(0).max(DESK_GRID_COLUMNS - 1),
        y: cell.min(0).max(DESK_GRID_ROWS_MAX - 1),
        w: cell.min(1).max(DESK_GRID_COLUMNS),
        h: cell.min(1).max(DESK_GRID_ROWS_MAX),
      })
      .strict()
      .refine((grid) => grid.x + grid.w <= DESK_GRID_COLUMNS, 'inside the columns')
      .refine((grid) => grid.y + grid.h <= DESK_GRID_ROWS_MAX, 'inside the rows'),
  })
  .strict();
export type DeskPanel = z.infer<typeof deskPanelSchema>;

type Grid = DeskPanel['grid'];
const overlaps = (a: Grid, b: Grid) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A free-form workspace's link groups: the same groups as a v1 desk's, its members named by panel id. */
export const deskPanelLinksSchema = z
  .object({
    members: z.record(id, colour),
    groups: z
      .object({
        red: deskLinkContextSchema.optional(),
        green: deskLinkContextSchema.optional(),
        blue: deskLinkContextSchema.optional(),
        amber: deskLinkContextSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .refine((links) => Object.values(links.members).every((name) => links.groups[name] !== undefined), "each member's group carries a market")
  .refine(
    (links) => DESK_LINK_COLOURS.every((name) => links.groups[name] === undefined || Object.values(links.members).includes(name)),
    'each group has a member',
  );
export type DeskPanelLinks = z.infer<typeof deskPanelLinksSchema>;

/** A free-form workspace: panels on a grid, none on another's cells. `preset` names the v1 preset it was read from. */
export const deskWorkspaceV2Schema = z
  .object({
    v: z.literal(2),
    columns: z.literal(DESK_GRID_COLUMNS),
    preset: z.enum(DESK_PRESET_IDS).optional(),
    panels: z.array(deskPanelSchema).min(1).max(DESK_PANELS_HARD_MAX),
    links: deskPanelLinksSchema.optional(),
  })
  .strict()
  .refine((desk) => new Set(desk.panels.map((panel) => panel.id)).size === desk.panels.length, 'each panel id once')
  .refine(
    (desk) => Object.keys(desk.links?.members ?? {}).every((member) => desk.panels.some((panel) => panel.id === member)),
    'a linked panel is on the desk',
  )
  .refine(
    (desk) => desk.panels.every((panel, i) => desk.panels.slice(i + 1).every((other) => !overlaps(panel.grid, other.grid))),
    'no two panels on one cell',
  );
export type DeskWorkspaceV2 = z.infer<typeof deskWorkspaceV2Schema>;

/** A stored layout's desk: either version. */
export const deskWorkspaceSchema = z.union([deskWorkspaceV1Schema, deskWorkspaceV2Schema]);
export type DeskWorkspace = z.infer<typeof deskWorkspaceSchema>;

/** Each v1 widget is one v2 panel type, and back. The v1 chart carries the order ticket docked under it. */
const V1_PANEL_TYPE = { markets: 'watchlist', chart: 'chart', book: 'depth', trades: 'tape' } as const;
type V1Widget = (typeof DESK_WIDGET_IDS)[number];
type V1Sized = Exclude<V1Widget, 'chart'>;
const V1_PRESET_WIDGETS: Record<(typeof DESK_PRESET_IDS)[number], readonly V1Widget[]> = {
  classic: ['markets', 'chart', 'book'],
  advanced: ['markets', 'chart', 'book', 'trades'],
};
/** The v1 desk is one row; read as v2 it is laid on a 96 rem reference width, this many rows high. */
const V1_REFERENCE_REM = 96;
const V1_ROW_HEIGHT = 24;
const CHART_SETTINGS = { orderEntry: 'docked' } as const;

/** The one migration: either version read as a v2 workspace. A v2 workspace is returned as it is. */
export function readDeskWorkspace(desk: DeskWorkspace): DeskWorkspaceV2 {
  if (desk.v === 2) return desk;
  const remPerColumn = V1_REFERENCE_REM / DESK_GRID_COLUMNS;
  const columns = new Map<V1Widget, number>();
  for (const widget of desk.order) {
    if (widget !== 'chart') columns.set(widget, Math.max(1, Math.round((desk.widths[widget] ?? 0) / remPerColumn)));
  }
  // The chart keeps at least one column: the widest fixed widget gives way first.
  const fixed = () => [...columns.values()].reduce((sum, w) => sum + w, 0);
  while (desk.order.includes('chart') && fixed() > DESK_GRID_COLUMNS - 1) {
    const [widest] = [...columns.entries()].sort((a, b) => b[1] - a[1]);
    if (!widest || widest[1] <= 1) break;
    columns.set(widest[0], widest[1] - 1);
  }
  const chartColumns = DESK_GRID_COLUMNS - fixed();
  let x = 0;
  const panels = desk.order.map((widget): DeskPanel => {
    const w = widget === 'chart' ? chartColumns : (columns.get(widget) ?? 1);
    const settings: DeskPanel['settings'] = widget === 'chart' ? { ...CHART_SETTINGS } : { widthRem: desk.widths[widget] ?? 0 };
    const panel = { id: widget, type: V1_PANEL_TYPE[widget], settings, grid: { x, y: 0, w, h: V1_ROW_HEIGHT } };
    x += w;
    return panel;
  });
  // Each v1 widget's panel keeps the widget's name as its id, so its link group carries over as it is.
  const links = desk.links ? { members: { ...desk.links.members }, groups: { ...desk.links.groups } } : undefined;
  return { v: 2, columns: DESK_GRID_COLUMNS, preset: desk.preset, panels, ...(links ? { links } : {}) };
}

const V1_OF_TYPE = new Map<string, V1Widget>(DESK_WIDGET_IDS.map((widget) => [V1_PANEL_TYPE[widget], widget]));

/** A v2 workspace as today's v1 desk, when that desk can draw all of it; else null. Nothing is dropped to make it fit. */
export function legacyDeskOf(desk: DeskWorkspace): DeskWorkspaceV1 | null {
  if (desk.v === 1) return desk;
  if (!desk.preset) return null;
  const row = [...desk.panels].sort((a, b) => a.grid.x - b.grid.x);
  let x = 0;
  const order: V1Widget[] = [];
  const widths: Partial<Record<V1Sized, number>> = {};
  for (const panel of row) {
    const widget = V1_OF_TYPE.get(panel.type);
    if (!widget || panel.id !== widget || panel.grid.y !== 0 || panel.grid.h !== V1_ROW_HEIGHT || panel.grid.x !== x) return null;
    x += panel.grid.w;
    const keys = Object.keys(panel.settings);
    if (widget === 'chart') {
      if (keys.length !== 1 || panel.settings.orderEntry !== CHART_SETTINGS.orderEntry) return null;
    } else {
      const width = panel.settings.widthRem;
      if (keys.length !== 1 || typeof width !== 'number') return null;
      widths[widget] = width;
    }
    order.push(widget);
  }
  if (x !== DESK_GRID_COLUMNS) return null;
  const expected = V1_PRESET_WIDGETS[desk.preset];
  if (order.length !== expected.length || !expected.every((widget) => order.includes(widget))) return null;
  const links = desk.links ? { members: { ...desk.links.members }, groups: { ...desk.links.groups } } : undefined;
  const parsed = deskWorkspaceV1Schema.safeParse({ v: 1, preset: desk.preset, order, widths, ...(links ? { links } : {}) });
  return parsed.success ? parsed.data : null;
}

export const deskLayoutSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(40),
    symbol,
    interval: z.enum(DESK_LAYOUT_INTERVALS),
    desk: deskWorkspaceSchema,
    savedAt: at,
  })
  .strict();
export type SavedDeskLayout = z.infer<typeof deskLayoutSchema>;

export const deletedDeskLayoutSchema = deskLayoutSchema.extend({ deletedAt: at }).strict();
export type DeletedDeskLayout = z.infer<typeof deletedDeskLayoutSchema>;

export const deskLayoutsValueSchema = z
  .object({
    layouts: z.array(deskLayoutSchema).max(DESK_LAYOUTS_HARD_MAX),
    /** The layout in use, autosaved into; null when none is. It names a layout in `layouts`. */
    active: id.nullable(),
    deleted: z.array(deletedDeskLayoutSchema).max(DESK_LAYOUTS_DELETED_HARD_MAX),
    /** The layout each desk (`spot`, `perps`, ...) opens on, by layout id. One naming no layout reads as none. */
    defaults: z
      .record(id, id)
      .refine((defaults) => Object.keys(defaults).length <= DESK_DEFAULTS_HARD_MAX, 'too many desks')
      .optional(),
  })
  .strict()
  .refine((value) => new Set(value.layouts.map((layout) => layout.id)).size === value.layouts.length, 'each layout id once')
  .refine(
    (value) => new Set(value.layouts.map((layout) => layout.name.toLowerCase())).size === value.layouts.length,
    'each layout name once',
  )
  .refine((value) => value.active === null || value.layouts.some((layout) => layout.id === value.active), 'active names a layout');
export type DeskLayoutsValue = z.infer<typeof deskLayoutsValueSchema>;

export const deskLayoutsPreferenceSchema = z
  .object({ namespace: z.literal(DESK_LAYOUTS_NAMESPACE), version: z.number().int(), value: deskLayoutsValueSchema.nullable() })
  .strict();
export type DeskLayoutsPreference = z.infer<typeof deskLayoutsPreferenceSchema>;

/** The layout a desk opens on by default, or null when none is set or the one set is no longer in the list. */
export function defaultLayoutFor(value: DeskLayoutsValue, desk: string): SavedDeskLayout | null {
  const layoutId = value.defaults?.[desk];
  return layoutId === undefined ? null : (value.layouts.find((layout) => layout.id === layoutId) ?? null);
}

export const EMPTY_DESK_LAYOUTS: DeskLayoutsValue = { layouts: [], active: null, deleted: [] };

/**
 * The client request id of a write: a business key, never random. One id per (person, version read, value written), so a
 * retry after a lost reply returns the first stored result.
 */
export function deskLayoutsRequestId(userId: string, ifVersion: number, value: unknown): string {
  return `${DESK_LAYOUTS_NAMESPACE}:${userId.toLowerCase()}:${ifVersion}:${digest(JSON.stringify(value))}`;
}

/** A short, stable digest (FNV-1a, 64 bits), so the id stays well under the 200 characters the door allows. */
function digest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

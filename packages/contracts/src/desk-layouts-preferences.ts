/**
 * The account's saved desk layouts (`trade.desk.layouts`, C-workspace-02, J-charts-desk-07 #3 to #5): named layouts of the
 * spot desk (the widget set, order and widths) with the symbol and chart interval they were saved on, the one in use
 * (autosaved into as the person changes the desk), and the recently deleted ones that can still be restored.
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

export const DESK_WIDGET_IDS = ['markets', 'chart', 'book', 'trades'] as const;
export const DESK_PRESET_IDS = ['classic', 'advanced'] as const;
/** The chart intervals a layout may name: the desk chart's own list. */
export const DESK_LAYOUT_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'] as const;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'id');
const symbol = z.string().regex(/^[A-Za-z0-9._-]{1,32}\/[A-Za-z0-9._:-]{1,32}$/, 'symbol');
const at = z.string().datetime({ offset: true });

/** The desk's widget workspace, as `apps/customer/src/screens/trade/desk/workspace.ts` draws it. Widths are rem. */
export const deskWorkspaceSchema = z
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
  })
  .strict()
  .refine((desk) => new Set(desk.order).size === desk.order.length, 'each widget once');

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

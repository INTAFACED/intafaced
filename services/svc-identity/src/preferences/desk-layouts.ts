/**
 * The account's saved desk layouts (`trade.desk.layouts`, C-workspace-02, J-charts-desk-07 #3 to #5). The shape lives in
 * `@intafaced/contracts/desk-layouts-preferences`; this file checks it and the owner's limits:
 *
 * - layouts per account: a write that adds a layout needs it set, and refuses past it;
 * - the deleted layouts kept for restoring, and for how many days: a write that deletes a layout needs both set, keeps no
 *   more than the count, and a layout comes back from the deleted list only inside the days.
 *
 * A limit the owner has not set is blank, and a blank limit refuses the write that needs it: nothing here invents one.
 * Growth is measured against the stored record, so a write that adds nothing (a rename, an autosave, a delete within the
 * limits) is judged only on what it changes. A view setting only: nothing here is read by an authorisation or a money path.
 */
import { DESK_LAYOUTS_NAMESPACE, deskLayoutsValueSchema, type DeskLayoutsValue } from '@intafaced/contracts/desk-layouts-preferences';
import { PREFERENCES_VALUE_INVALID } from './trade-views.js';

export { DESK_LAYOUTS_NAMESPACE };
export type { DeskLayoutsValue };

export const DESK_LAYOUT_CAP_UNSET = 'identity.desk_layout_cap_unset' as const;
export const DESK_LAYOUT_CAP_EXCEEDED = 'identity.desk_layout_cap_exceeded' as const;
export const DESK_LAYOUT_RESTORE_UNSET = 'identity.desk_layout_restore_unset' as const;
export const DESK_LAYOUT_RESTORE_FULL = 'identity.desk_layout_restore_full' as const;
export const DESK_LAYOUT_RESTORE_EXPIRED = 'identity.desk_layout_restore_expired' as const;

/** The owner's limits. Null is blank (not set). */
export interface DeskLayoutLimits {
  readonly layoutCap: number | null;
  readonly restoreCap: number | null;
  readonly restoreDays: number | null;
}
export const NO_DESK_LAYOUT_LIMITS: DeskLayoutLimits = { layoutCap: null, restoreCap: null, restoreDays: null };

function refuse(code: string): never {
  const error = new Error(code);
  (error as Error & { code: string }).code = code;
  throw error;
}

/** The shape alone: a value that is not the shape is refused as invalid. */
export function parseDeskLayoutsShape(value: unknown): DeskLayoutsValue {
  const parsed = deskLayoutsValueSchema.safeParse(value);
  if (!parsed.success) refuse(PREFERENCES_VALUE_INVALID);
  return parsed.data;
}

const DAY_MS = 86_400_000;

/** Refuses a write that adds a layout past the cap, deletes past the restore list, or restores outside the window. */
export function checkDeskLayoutGrowth(
  next: DeskLayoutsValue,
  stored: DeskLayoutsValue | null,
  limits: DeskLayoutLimits,
  now: Date = new Date(),
): void {
  const before = stored ?? { layouts: [], active: null, deleted: [] };
  const storedIds = new Set(before.layouts.map((layout) => layout.id));
  const storedDeleted = new Map(before.deleted.map((layout) => [layout.id, layout]));

  // A layout back from the deleted list: only inside the owner's days.
  for (const layout of next.layouts) {
    if (storedIds.has(layout.id)) continue;
    const deleted = storedDeleted.get(layout.id);
    if (!deleted) continue;
    if (limits.restoreDays === null) refuse(DESK_LAYOUT_RESTORE_UNSET);
    if (Date.parse(deleted.deletedAt) + limits.restoreDays * DAY_MS < now.getTime()) refuse(DESK_LAYOUT_RESTORE_EXPIRED);
  }

  if (next.layouts.length > before.layouts.length) {
    if (limits.layoutCap === null) refuse(DESK_LAYOUT_CAP_UNSET);
    if (next.layouts.length > limits.layoutCap) refuse(DESK_LAYOUT_CAP_EXCEEDED);
  }

  const newlyDeleted = next.deleted.filter((layout) => !storedDeleted.has(layout.id));
  if (newlyDeleted.length > 0) {
    if (limits.restoreCap === null || limits.restoreDays === null) refuse(DESK_LAYOUT_RESTORE_UNSET);
    if (next.deleted.length > limits.restoreCap) refuse(DESK_LAYOUT_RESTORE_FULL);
  }
}

/**
 * The chart desk's saved layouts (`trade.layouts`) and chart templates (`trade.chart-templates`), C-workspace-02 and
 * C-embed-feed-ops-03. The shapes live in `@intafaced/contracts/layouts-preferences`; this file checks them and the owner's
 * limits. A limit the owner has not set is blank, and a blank limit refuses the write that needs it: nothing here invents one.
 * A view setting only: nothing here is read by an authorisation or a money path.
 *
 * Deleted layouts stay for the owner's restore window and no longer than the owner's restore list. The window is applied when
 * the record is read (a layout past it is not returned) and when it is written (it is dropped from the stored record).
 */
import {
  CHART_TEMPLATES_NAMESPACE,
  LAYOUTS_NAMESPACE,
  LAYOUT_MAX_BYTES,
  chartTemplatesValueSchema,
  layoutsValueSchema,
  type ChartTemplatesValue,
  type LayoutsValue,
} from '@intafaced/contracts/layouts-preferences';
import { PREFERENCES_VALUE_INVALID, PREFERENCES_VALUE_TOO_LARGE, stableJson } from './trade-views.js';

export { CHART_TEMPLATES_NAMESPACE, LAYOUTS_NAMESPACE };

export const LAYOUT_CAP_UNSET = 'identity.layout_cap_unset' as const;
export const LAYOUT_CAP_EXCEEDED = 'identity.layout_cap_exceeded' as const;
export const LAYOUT_RESTORE_UNSET = 'identity.layout_restore_unset' as const;
export const LAYOUT_RESTORE_LIST_FULL = 'identity.layout_restore_list_full' as const;
export const CHART_TEMPLATE_CAP_UNSET = 'identity.chart_template_cap_unset' as const;
export const CHART_TEMPLATE_CAP_EXCEEDED = 'identity.chart_template_cap_exceeded' as const;

const DAY_MS = 86_400_000;

/** The owner's limits: layouts per person, the restore window in days, the restore list size, templates per person. Null is blank. */
export interface LayoutCaps {
  readonly layoutCap: number | null;
  readonly restoreDays: number | null;
  readonly restoreListSize: number | null;
  readonly templateCap: number | null;
}
export const NO_LAYOUT_CAPS: LayoutCaps = { layoutCap: null, restoreDays: null, restoreListSize: null, templateCap: null };

function refuse(code: string): never {
  const error = new Error(code);
  (error as Error & { code: string }).code = code;
  throw error;
}

function checkBytes(value: unknown): void {
  if (Buffer.byteLength(stableJson(value), 'utf8') > LAYOUT_MAX_BYTES) {
    refuse(PREFERENCES_VALUE_TOO_LARGE);
  }
}

/** The deleted layouts still inside the window, newest first. A blank window keeps none. */
export function keptDeleted(value: LayoutsValue, restoreDays: number | null, now: number): LayoutsValue['deleted'] {
  if (restoreDays === null) return [];
  const horizon = restoreDays * DAY_MS;
  return value.deleted.filter((entry) => now - Date.parse(entry.deletedAt) <= horizon);
}

/**
 * Strict shape, the size guard, then the owner's limits. A save with layouts while the layout cap is blank is refused, and so is
 * one over the cap. Deleted layouts need a restore window and a restore list size; past the window they are dropped.
 */
export function parseLayouts(value: unknown, caps: LayoutCaps = NO_LAYOUT_CAPS, now: number = Date.now()): LayoutsValue {
  const parsed = layoutsValueSchema.safeParse(value);
  if (!parsed.success) refuse(PREFERENCES_VALUE_INVALID);
  checkBytes(parsed.data);
  const layouts = parsed.data.layouts;
  if (layouts.length > 0 && caps.layoutCap === null) refuse(LAYOUT_CAP_UNSET);
  if (caps.layoutCap !== null && layouts.length > caps.layoutCap) refuse(LAYOUT_CAP_EXCEEDED);
  if (parsed.data.deleted.length > 0 && (caps.restoreDays === null || caps.restoreListSize === null)) refuse(LAYOUT_RESTORE_UNSET);
  const deleted = keptDeleted(parsed.data, caps.restoreDays, now);
  if (caps.restoreListSize !== null && deleted.length > caps.restoreListSize) refuse(LAYOUT_RESTORE_LIST_FULL);
  return { layouts, deleted };
}

/** The record as a person reads it: deleted layouts past the window are not returned. */
export function layoutsForRead(value: LayoutsValue | null, caps: LayoutCaps, now: number = Date.now()): LayoutsValue | null {
  if (value === null) return null;
  return { layouts: value.layouts, deleted: keptDeleted(value, caps.restoreDays, now) };
}

/** Strict shape, the size guard, then the template cap. A blank cap refuses any template record. */
export function parseChartTemplates(value: unknown, caps: LayoutCaps = NO_LAYOUT_CAPS): ChartTemplatesValue {
  const parsed = chartTemplatesValueSchema.safeParse(value);
  if (!parsed.success) refuse(PREFERENCES_VALUE_INVALID);
  checkBytes(parsed.data);
  const templates = parsed.data;
  if (templates.length > 0 && caps.templateCap === null) refuse(CHART_TEMPLATE_CAP_UNSET);
  if (caps.templateCap !== null && templates.length > caps.templateCap) refuse(CHART_TEMPLATE_CAP_EXCEEDED);
  return templates;
}

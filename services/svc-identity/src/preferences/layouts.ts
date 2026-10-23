/**
 * The chart desk's saved layouts (`trade.layouts`) and chart templates (`trade.chart-templates`), C-workspace-02 and
 * C-embed-feed-ops-03. The shapes live in `@intafaced/contracts/layouts-preferences`; this file checks them and the owner's
 * limits. A limit the owner has not set is blank, and a blank limit refuses the write that needs it: nothing here invents one.
 * A view setting only: nothing here is read by an authorisation or a money path.
 *
 * Two steps, so the rules can see the record a write replaces:
 *   1. `parse*Shape` checks the shape and the size. It runs before the write is fingerprinted, so a retry is recognised.
 *   2. `settleLayouts` / `settleTemplates` run inside the write's transaction, against the stored record. The owner's caps apply
 *      only to growth (a new layout, a recovered one, a new template). A delete always passes. A deleted layout's time is stamped
 *      by the server when it is first seen as deleted, so the restore window cannot be moved by the client.
 */
import {
  CHART_TEMPLATES_NAMESPACE,
  LAYOUTS_NAMESPACE,
  LAYOUT_MAX_BYTES,
  NO_LAYOUTS,
  chartTemplatesValueSchema,
  layoutsValueSchema,
  type ChartTemplatesValue,
  type LayoutsValue,
} from '@intafaced/contracts/layouts-preferences';
import { PREFERENCES_VALUE_INVALID, PREFERENCES_VALUE_TOO_LARGE, stableJson } from './trade-views.js';

export { CHART_TEMPLATES_NAMESPACE, LAYOUTS_NAMESPACE };

export const LAYOUT_CAP_UNSET = 'identity.layout_cap_unset' as const;
export const LAYOUT_CAP_EXCEEDED = 'identity.layout_cap_exceeded' as const;
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

/** Shape and size only. Limits are settled later, against the record the write replaces. */
export function parseLayoutShape(value: unknown): LayoutsValue {
  const parsed = layoutsValueSchema.safeParse(value);
  if (!parsed.success) refuse(PREFERENCES_VALUE_INVALID);
  checkBytes(parsed.data);
  return parsed.data;
}

/**
 * The record as it is stored after a write. `previous` is the record this write replaces (null when there is none).
 * - A layout count that grows needs the layout cap: blank refuses, and so does a count over it. Updates and deletes pass.
 * - A deleted layout keeps the time the server first saw it deleted; the client's own time is never stored.
 * - Deleted layouts past the owner's window are dropped; with the window or the list size blank nothing is kept. The list is
 *   trimmed to the owner's list size, newest first. A delete is never refused for a limit.
 */
export function settleLayouts(
  value: LayoutsValue,
  previous: LayoutsValue | null,
  caps: LayoutCaps,
  now: number = Date.now(),
): LayoutsValue {
  const before = previous ?? NO_LAYOUTS;
  if (value.layouts.length > before.layouts.length) {
    if (caps.layoutCap === null) refuse(LAYOUT_CAP_UNSET);
    if (value.layouts.length > caps.layoutCap) refuse(LAYOUT_CAP_EXCEEDED);
  }
  const stamped = new Map(before.deleted.map((entry) => [entry.layout.id, entry.deletedAt]));
  const nowIso = new Date(now).toISOString();
  let deleted = value.deleted.map((entry) => ({ layout: entry.layout, deletedAt: stamped.get(entry.layout.id) ?? nowIso }));
  if (caps.restoreDays === null || caps.restoreListSize === null) {
    deleted = [];
  } else {
    const horizon = caps.restoreDays * DAY_MS;
    deleted = deleted.filter((entry) => now - Date.parse(entry.deletedAt) <= horizon).slice(0, caps.restoreListSize);
  }
  return { layouts: value.layouts, deleted };
}

/** The record as a person reads it: deleted layouts past the window are not returned. */
export function layoutsForRead(value: LayoutsValue | null, caps: LayoutCaps, now: number = Date.now()): LayoutsValue | null {
  if (value === null) return null;
  if (caps.restoreDays === null) return { layouts: value.layouts, deleted: [] };
  const horizon = caps.restoreDays * DAY_MS;
  return {
    layouts: value.layouts,
    deleted: value.deleted.filter((entry) => now - Date.parse(entry.deletedAt) <= horizon),
  };
}

/** Shape and size only, for a template record. */
export function parseChartTemplateShape(value: unknown): ChartTemplatesValue {
  const parsed = chartTemplatesValueSchema.safeParse(value);
  if (!parsed.success) refuse(PREFERENCES_VALUE_INVALID);
  checkBytes(parsed.data);
  return parsed.data;
}

/** Growth-only: a template count that grows needs the template cap. Blank refuses; over the cap refuses. Edits and removals pass. */
export function settleChartTemplates(
  value: ChartTemplatesValue,
  previous: ChartTemplatesValue | null,
  caps: LayoutCaps,
): ChartTemplatesValue {
  const before = previous ?? [];
  if (value.length > before.length) {
    if (caps.templateCap === null) refuse(CHART_TEMPLATE_CAP_UNSET);
    if (value.length > caps.templateCap) refuse(CHART_TEMPLATE_CAP_EXCEEDED);
  }
  return value;
}

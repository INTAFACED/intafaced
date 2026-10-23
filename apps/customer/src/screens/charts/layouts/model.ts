/**
 * The desk's presets and the saved-layout record, as pure functions. A record is the person's layouts and the deleted ones kept
 * for the owner's recovery window; each change returns the next record, and the caller writes it through the account store.
 * Nothing here reads browser storage or the network (see capture.ts for the device side).
 */
import {
  deskSettingSchema,
  layoutSnapshotSchema,
  LAYOUT_NAME_MAX,
  type ChartTemplate,
  type ChartTemplatesValue,
  type DeskSetting,
  type LayoutsValue,
  type LayoutSnapshot,
  type SavedLayout,
} from '@intafaced/contracts/layouts-preferences';

export type DeskPreset = DeskSetting['preset'];

/** The two presets. Classic is the simple desk; Advanced adds the studies bar and the drawing tools. */
export const PRESET_DESK: Readonly<Record<DeskPreset, DeskSetting>> = {
  classic: { preset: 'classic', side: 'right', studies: false, drawings: false },
  advanced: { preset: 'advanced', side: 'right', studies: true, drawings: true },
};
/** The desk a device gets when nothing is stored: Advanced, so the studies bar and drawing tools stay where they were. */
export const DEFAULT_DESK: DeskSetting = PRESET_DESK.advanced;

/** A stored desk that does not read as one is ignored: the preset stands, with no error. */
export const isDeskSetting = (value: unknown): value is DeskSetting => deskSettingSchema.safeParse(value).success;

/** The desk after a preset is picked: the preset's widgets, on the side the person put the watchlist on. */
export function deskForPreset(preset: DeskPreset, side: DeskSetting['side']): DeskSetting {
  return { ...PRESET_DESK[preset], side };
}

/** The name a layout is saved under: trimmed, and never longer than the limit the contract allows. */
export function cleanName(text: string): string {
  return text.trim().slice(0, LAYOUT_NAME_MAX);
}
/** Names are compared without case and spacing: "Scalp" and " scalp " are the same layout. */
export const sameName = (a: string, b: string): boolean => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();

export function findLayout(record: LayoutsValue, id: string): SavedLayout | undefined {
  return record.layouts.find((layout) => layout.id === id);
}

export type SaveOutcome = { ok: true; record: LayoutsValue; layout: SavedLayout } | { ok: false; why: 'name-needed' | 'name-taken' };

/** A new layout under a name no other layout has. A taken name asks first: see `replaceNamed`. */
export function saveNamed(record: LayoutsValue, name: string, snapshot: LayoutSnapshot, now: string, newId: string): SaveOutcome {
  const label = cleanName(name);
  if (label === '') return { ok: false, why: 'name-needed' };
  if (record.layouts.some((layout) => sameName(layout.name, label))) return { ok: false, why: 'name-taken' };
  const layout: SavedLayout = { id: newId, name: label, savedAt: now, snapshot: layoutSnapshotSchema.parse(snapshot) };
  return { ok: true, record: { ...record, layouts: [layout, ...record.layouts] }, layout };
}

/** Replace the layout that holds this name, keeping its id: the second save under one name. */
export function replaceNamed(record: LayoutsValue, name: string, snapshot: LayoutSnapshot, now: string): SaveOutcome {
  const label = cleanName(name);
  const target = record.layouts.find((layout) => sameName(layout.name, label));
  if (!target) return { ok: false, why: 'name-needed' };
  const layout: SavedLayout = { ...target, name: label, savedAt: now, snapshot: layoutSnapshotSchema.parse(snapshot) };
  return {
    ok: true,
    record: { ...record, layouts: record.layouts.map((entry) => (entry.id === target.id ? layout : entry)) },
    layout,
  };
}

/** A copy of a layout: the same settings under its own id and a name no layout holds. */
export function copyLayout(record: LayoutsValue, id: string, newId: string, now: string): SaveOutcome | null {
  const source = findLayout(record, id);
  if (!source) return null;
  let label = cleanName(`${source.name} copy`);
  for (let n = 2; record.layouts.some((layout) => sameName(layout.name, label)); n += 1) {
    label = cleanName(`${source.name} copy ${n}`);
  }
  const layout: SavedLayout = { id: newId, name: label, savedAt: now, snapshot: source.snapshot };
  return { ok: true, record: { ...record, layouts: [layout, ...record.layouts] }, layout };
}

/** Move a layout to the deleted list, newest first. It stays there for the owner's recovery window. */
export function deleteLayout(record: LayoutsValue, id: string, now: string): LayoutsValue | null {
  const source = findLayout(record, id);
  if (!source) return null;
  return {
    layouts: record.layouts.filter((layout) => layout.id !== id),
    deleted: [{ layout: source, deletedAt: now }, ...record.deleted],
  };
}

/** Bring a deleted layout back with its charts and settings. */
export function recoverLayout(record: LayoutsValue, id: string): LayoutsValue | null {
  const entry = record.deleted.find((item) => item.layout.id === id);
  if (!entry) return null;
  return {
    layouts: [entry.layout, ...record.layouts],
    deleted: record.deleted.filter((item) => item.layout.id !== id),
  };
}

/** The same layout with a new snapshot: the autosave of the open layout. */
export function withSnapshot(record: LayoutsValue, id: string, snapshot: LayoutSnapshot, now: string): LayoutsValue | null {
  const target = findLayout(record, id);
  if (!target) return null;
  const next: SavedLayout = { ...target, savedAt: now, snapshot: layoutSnapshotSchema.parse(snapshot) };
  return { ...record, layouts: record.layouts.map((layout) => (layout.id === id ? next : layout)) };
}

export const EXPORT_FORMAT = 'intafaced.chart-layout.v1' as const;

/**
 * A layout as a file: its name, when it was saved, and its settings. The candles are never in it, and neither is a balance.
 */
export function exportText(layout: SavedLayout): string {
  return JSON.stringify({ format: EXPORT_FORMAT, name: layout.name, savedAt: layout.savedAt, snapshot: layout.snapshot }, null, 2);
}

/** The file name a layout exports under: its name in lower case, with a dash for each run of other characters. */
export function exportFileName(layout: SavedLayout): string {
  const slug = layout.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'layout'}.layout.json`;
}

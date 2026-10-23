/**
 * The device side of a layout: what the workbench keeps in browser storage, read into a snapshot, and a snapshot written back
 * to the same keys before the page is shown again. A layout is the workbench's own settings, so this file uses the keys those
 * components already read (`settingKey`, `gridKey`, the studies store per chart slot, the drawings per symbol). Browser storage
 * can be blocked or full: a write that fails is reported, never dropped silently.
 */
import type { DeskSetting, LayoutSnapshot } from '@intafaced/contracts/layouts-preferences';
import { gridKey, isGridSetting, DEFAULT_GRID, type GridSetting, GROUPS } from '../grid';
import { settingKey, type WorkbenchSetting } from '../workbench';
import { storeKey } from '../studies/model';
import { drawingsKey } from '../drawings/store';

/** The chart slots a grid can hold. A slot's studies store is keyed like the studies bar keys it (slot 0 is the workbench). */
export const CHART_SLOTS = 4;

export const deskKey = (userId: string | null, workbench: string): string => `charts-desk:${userId ?? 'guest'}:${workbench}`;
export const activeLayoutKey = (userId: string | null, workbench: string): string =>
  `charts-layout-active:${userId ?? 'guest'}:${workbench}`;
export const firstGroupKey = (userId: string | null, workbench: string): string => `${gridKey(userId, workbench)}:first`;
/** The studies store of one chart slot: slot 0 is the workbench's own, the others are keyed as the grid's cells key them. */
export const studiesKey = (userId: string | null, workbench: string, slot: number): string =>
  storeKey(userId, slot === 0 ? workbench : `${workbench}:${slot}`);

/** One write to browser storage: a value, or null to remove the key. */
export interface StorageWrite {
  key: string;
  value: string | null;
}

/** A value stored as JSON, or null when nothing is stored, storage is blocked, or the text is not JSON. */
function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

const GROUP_TAGS: readonly string[] = [...GROUPS, 'none'];

/** The snapshot of the workbench as it is on this device now. Reads only; nothing is written. */
export function captureSnapshot(input: {
  userId: string | null;
  workbench: string;
  symbol: string;
  setting: WorkbenchSetting;
  desk: DeskSetting;
}): LayoutSnapshot {
  const stored = readStored(gridKey(input.userId, input.workbench));
  const grid: GridSetting = isGridSetting(stored) ? stored : DEFAULT_GRID;
  const tag = readStored(firstGroupKey(input.userId, input.workbench));
  const firstGroup = typeof tag === 'string' && GROUP_TAGS.includes(tag) ? (tag as LayoutSnapshot['firstGroup']) : 'blue';
  const studies: unknown[] = [];
  for (let slot = 0; slot < CHART_SLOTS; slot += 1) studies.push(readStored(studiesKey(input.userId, input.workbench, slot)));
  return {
    symbol: input.symbol,
    interval: input.setting.interval,
    mode: input.setting.mode,
    scheme: input.setting.scheme ?? 'standard',
    desk: input.desk,
    firstGroup,
    grid: {
      layout: grid.layout,
      sync: grid.sync,
      cells: grid.cells.map((cell) => ({ symbol: cell.symbol, interval: cell.interval, mode: cell.mode, group: cell.group })),
      sizes: {
        cols: [grid.sizes.cols[0] ?? 1, grid.sizes.cols[1] ?? 1],
        rows: [grid.sizes.rows[0] ?? 1, grid.sizes.rows[1] ?? 1],
      },
    },
    studies,
    drawings: readStored(drawingsKey(input.userId, input.workbench, input.symbol)),
  };
}

/** The writes that make the device show this snapshot: the setting, the grid, the studies per slot, the drawings and the desk. */
export function planWrites(snapshot: LayoutSnapshot, userId: string | null, workbench: string): StorageWrite[] {
  const json = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));
  const writes: StorageWrite[] = [
    { key: settingKey(userId, workbench), value: json({ interval: snapshot.interval, mode: snapshot.mode, scheme: snapshot.scheme }) },
    { key: gridKey(userId, workbench), value: json(snapshot.grid) },
    { key: firstGroupKey(userId, workbench), value: json(snapshot.firstGroup) },
    { key: deskKey(userId, workbench), value: json(snapshot.desk) },
    { key: drawingsKey(userId, workbench, snapshot.symbol), value: json(snapshot.drawings) },
  ];
  for (let slot = 0; slot < CHART_SLOTS; slot += 1) {
    writes.push({ key: studiesKey(userId, workbench, slot), value: json(snapshot.studies[slot] ?? null) });
  }
  return writes;
}

/** Apply the writes in order. False when storage refused one: the change is not shown as opened. */
export function applyWrites(
  writes: readonly StorageWrite[],
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage(),
): boolean {
  if (!storage) return false;
  try {
    for (const write of writes) {
      if (write.value === null) storage.removeItem(write.key);
      else storage.setItem(write.key, write.value);
    }
    return true;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

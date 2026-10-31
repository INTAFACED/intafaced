/**
 * The person's studies on one workbench, as they are kept on this device. A study instance is a kind, its inputs as the
 * person typed them (strings, so a blank stays blank), a colour token and the intervals it is hidden on. Visibility is per
 * interval: a study hidden on 1h still shows on every other interval. The store also remembers the last settings of a
 * removed study, so it can be added back the way it was.
 */
import type { ChartInterval } from '../../trade/chart/candles';
import { isChartInterval } from '../workbench';
import { PALETTE, STUDIES, studyDef, type PaletteToken, type StudyKind } from './catalogue';

export interface StudyInstance {
  id: string;
  kind: StudyKind;
  inputs: Record<string, string>;
  color: PaletteToken;
  /** The intervals this study is hidden on. Every other interval shows it. */
  hiddenOn: ChartInterval[];
}

export interface Remembered {
  inputs: Record<string, string>;
  color: PaletteToken;
}

export interface StudyStore {
  studies: StudyInstance[];
  remembered: Partial<Record<StudyKind, Remembered>>;
  /** The legend shows the values of the last bar without a pointer over the chart. */
  legendAlways: boolean;
  /** How the indicator panes are laid out. Absent in a store saved before panes could be arranged: the defaults stand. */
  panes?: PaneLayout;
}

/**
 * The indicator panes' arrangement, by study id. Their order is the studies' own order. A study on the main pane draws
 * over the price on a scale of its own; a collapsed pane keeps a thin strip; a pane's size is its height against the
 * others (1 is the default); one pane may be maximised, which shrinks every other pane until it is restored.
 */
export interface PaneLayout {
  onMain: string[];
  collapsed: string[];
  sizes: Record<string, number>;
  maximised: string | null;
}

export const NO_PANES: PaneLayout = { onMain: [], collapsed: [], sizes: {}, maximised: null };

/** The smallest and largest size a pane may be given, against the default 1. */
export const PANE_SIZE_MIN = 0.25;
export const PANE_SIZE_MAX = 4;
const clampSize = (size: number): number => Math.min(PANE_SIZE_MAX, Math.max(PANE_SIZE_MIN, size));

/**
 * The layout a store holds, read defensively: a layout that does not have the shape falls back to the defaults (the
 * studies themselves are kept), and every size is held within the bounds.
 */
export function panesOf(store: StudyStore): PaneLayout {
  const layout = store.panes;
  if (!isPaneLayout(layout)) return NO_PANES;
  return { ...layout, sizes: Object.fromEntries(Object.entries(layout.sizes).map(([id, size]) => [id, clampSize(size)])) };
}

export function setPanes(store: StudyStore, patch: Partial<PaneLayout>): StudyStore {
  return { ...store, panes: { ...panesOf(store), ...patch } };
}

const toggled = (list: readonly string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
export const toggleOnMain = (store: StudyStore, id: string): StudyStore => {
  const layout = panesOf(store);
  return setPanes(store, { onMain: toggled(layout.onMain, id), maximised: layout.maximised === id ? null : layout.maximised });
};
export const toggleCollapsed = (store: StudyStore, id: string): StudyStore =>
  setPanes(store, { collapsed: toggled(panesOf(store).collapsed, id) });
export const toggleMaximised = (store: StudyStore, id: string): StudyStore =>
  setPanes(store, { maximised: panesOf(store).maximised === id ? null : id });
/** Scales a pane's size by a factor, within the bounds. */
export const resizePane = (store: StudyStore, id: string, by: number): StudyStore => {
  const layout = panesOf(store);
  return setPanes(store, { sizes: { ...layout.sizes, [id]: clampSize((layout.sizes[id] ?? 1) * by) } });
};
/** Sizes read back from the chart after the person dragged a pane border. */
export const setPaneSizes = (store: StudyStore, sizes: Record<string, number>): StudyStore =>
  setPanes(store, {
    sizes: { ...panesOf(store).sizes, ...Object.fromEntries(Object.entries(sizes).map(([id, size]) => [id, clampSize(size)])) },
  });

/**
 * Moves a pane one place up or down among the panes drawn (`order`, the ids that have a pane of their own, top to
 * bottom), by swapping the two studies in the list. Nothing moves past the first or last pane.
 */
export function movePane(store: StudyStore, id: string, by: -1 | 1, order: readonly string[]): StudyStore {
  const at = order.indexOf(id);
  const other = order[at + by];
  if (at < 0 || other === undefined) return store;
  const studies = [...store.studies];
  const [i, j] = [studies.findIndex((s) => s.id === id), studies.findIndex((s) => s.id === other)];
  if (i < 0 || j < 0) return store;
  [studies[i], studies[j]] = [studies[j]!, studies[i]!];
  return { ...store, studies };
}

export const EMPTY_STORE: StudyStore = { studies: [], remembered: {}, legendAlways: false };

/** A workbench nobody has studied yet: Volume is on, as the desk's first chart always had it. Removing it is kept like any change. */
export const FRESH_STORE: StudyStore = {
  studies: [{ id: 'volume-1', kind: 'volume', inputs: {}, color: 'ma-1', hiddenOn: [] }],
  remembered: {},
  legendAlways: false,
};

export const defaultInputs = (kind: StudyKind): Record<string, string> =>
  Object.fromEntries(studyDef(kind).inputs.map((input) => [input.key, input.default]));

export const shownOn = (study: StudyInstance, interval: ChartInterval): boolean => !study.hiddenOn.includes(interval);

/** A new id for a kind: the kind and the next free number (`sma-2`). Ids are local to the workbench. */
function nextId(studies: readonly StudyInstance[], kind: StudyKind): string {
  const taken = new Set(studies.map((s) => s.id));
  let n = 1;
  while (taken.has(`${kind}-${n}`)) n += 1;
  return `${kind}-${n}`;
}

/** Adds a study with the defaults shown in its fields, or with the settings it was last removed with. */
export function addStudy(store: StudyStore, kind: StudyKind): StudyStore {
  const last = store.remembered[kind];
  const study: StudyInstance = {
    id: nextId(store.studies, kind),
    kind,
    inputs: last ? { ...last.inputs } : defaultInputs(kind),
    color: last?.color ?? PALETTE[0],
    hiddenOn: [],
  };
  return { ...store, studies: [...store.studies, study] };
}

/** Removes a study and remembers its settings for when it is added again. */
export function removeStudy(store: StudyStore, id: string): StudyStore {
  const gone = store.studies.find((s) => s.id === id);
  if (!gone) return store;
  return {
    ...store,
    studies: store.studies.filter((s) => s.id !== id),
    ...(store.panes === undefined
      ? {}
      : {
          panes: (({ onMain, collapsed, sizes, maximised }) => ({
            onMain: onMain.filter((x) => x !== id),
            collapsed: collapsed.filter((x) => x !== id),
            sizes: Object.fromEntries(Object.entries(sizes).filter(([x]) => x !== id)),
            maximised: maximised === id ? null : maximised,
          }))(panesOf(store)),
        }),
    remembered: { ...store.remembered, [gone.kind]: { inputs: { ...gone.inputs }, color: gone.color } },
  };
}

export function updateStudy(
  store: StudyStore,
  id: string,
  patch: Partial<Pick<StudyInstance, 'inputs' | 'color' | 'hiddenOn'>>,
): StudyStore {
  return { ...store, studies: store.studies.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const kinds = new Set<string>(STUDIES.map((s) => s.kind));
const isInputs = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((v) => typeof v === 'string' && v.length <= 16);
const isColor = (value: unknown): value is PaletteToken => (PALETTE as readonly unknown[]).includes(value);
const isStudy = (value: unknown): value is StudyInstance =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  /^[a-z0-9-]{1,40}$/.test(value.id) &&
  typeof value.kind === 'string' &&
  kinds.has(value.kind) &&
  isInputs(value.inputs) &&
  isColor(value.color) &&
  Array.isArray(value.hiddenOn) &&
  value.hiddenOn.every(isChartInterval);

const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
const isPaneLayout = (value: unknown): value is PaneLayout =>
  isRecord(value) &&
  isIds(value.onMain) &&
  isIds(value.collapsed) &&
  isRecord(value.sizes) &&
  Object.values(value.sizes).every((v) => typeof v === 'number' && Number.isFinite(v)) &&
  (value.maximised === null || typeof value.maximised === 'string');

/** A stored store that does not match the shape is ignored (the empty store stands), with no error. */
export const isStudyStore = (value: unknown): value is StudyStore =>
  isRecord(value) &&
  Array.isArray(value.studies) &&
  value.studies.every(isStudy) &&
  isRecord(value.remembered) &&
  Object.entries(value.remembered).every(([kind, r]) => kinds.has(kind) && isRecord(r) && isInputs(r.inputs) && isColor(r.color)) &&
  typeof value.legendAlways === 'boolean';

export const storeKey = (userId: string | null, workbench: string): string => `charts-studies:${userId ?? 'guest'}:${workbench}`;

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
}

export const EMPTY_STORE: StudyStore = { studies: [], remembered: {}, legendAlways: false };

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

/** A stored store that does not match the shape is ignored (the empty store stands), with no error. */
export const isStudyStore = (value: unknown): value is StudyStore =>
  isRecord(value) &&
  Array.isArray(value.studies) &&
  value.studies.every(isStudy) &&
  isRecord(value.remembered) &&
  Object.entries(value.remembered).every(([kind, r]) => kinds.has(kind) && isRecord(r) && isInputs(r.inputs) && isColor(r.color)) &&
  typeof value.legendAlways === 'boolean';

export const storeKey = (userId: string | null, workbench: string): string => `charts-studies:${userId ?? 'guest'}:${workbench}`;

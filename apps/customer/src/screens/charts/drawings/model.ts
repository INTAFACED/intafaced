/**
 * The drawing model: what a person has drawn on one workbench's chart for one symbol. A drawing is stored by bar time (epoch
 * seconds of the bar's open) and decimal price, never by pixel, so it survives a zoom or a pan. Every operation here is
 * pure: it returns a new document or a typed refusal, and the hook decides what to show.
 */
import { dec, roundToTick, add, type Decimal } from './decimal';
import { collinear, EXTENSION_LEVELS, FIB_LEVELS, type Pt, type Refusal } from './geometry';

export type DrawingKind =
  | 'horizontal'
  | 'ray'
  | 'vertical'
  | 'cross'
  | 'trend'
  | 'info'
  | 'text'
  | 'fib'
  | 'fibExtension'
  | 'channel'
  | 'pitchfork'
  | 'gannFan'
  | 'gannBox'
  | 'pattern'
  | 'long'
  | 'short'
  | 'measure'
  | 'rectangle'
  | 'ellipse'
  | 'brush';

export type PatternVariant = 'abcd' | 'xabcd';
/** Colour as a token name; the canvas reads the token (`--if-*`), never a literal. */
export type Tone = 'accent' | 'up' | 'down' | 'text';
export const TONES: readonly Tone[] = ['accent', 'up', 'down', 'text'];

export interface Drawing {
  id: string;
  kind: DrawingKind;
  points: Pt[];
  /** Pattern variant (`abcd` four points, `xabcd` five). */
  variant?: PatternVariant;
  /** Text annotation content. */
  text?: string;
  /** Text size in pixels (a UI default of 14 when unset). */
  size?: number;
  tone: Tone;
  /** Fibonacci levels, editable by the person. */
  levels?: Decimal[];
  locked: boolean;
  hidden: boolean;
  groupId?: string;
}

export interface Group {
  id: string;
  name: string;
  hidden: boolean;
}

export interface DrawingDoc {
  version: 1;
  drawings: Drawing[];
  groups: Group[];
  /** Hide all drawings: the objects are kept and shown again when this is off. */
  hiddenAll: boolean;
}

export const EMPTY_DOC: DrawingDoc = { version: 1, drawings: [], groups: [], hiddenAll: false };

/** How many points a drawing needs before it is complete. `brush` is free-hand and completed by lifting the pointer. */
export function pointsNeeded(kind: DrawingKind, variant?: PatternVariant): number {
  switch (kind) {
    case 'horizontal':
    case 'vertical':
    case 'cross':
    case 'text':
      return 1;
    case 'fibExtension':
    case 'channel':
    case 'pitchfork':
    case 'long':
    case 'short':
      return 3;
    case 'pattern':
      return variant === 'xabcd' ? 5 : 4;
    case 'brush':
      return 2;
    default:
      return 2;
  }
}

export const SIZE_DEFAULT = 14;

/** The tone a new drawing takes: positions show their profit side and loss side; text the neutral one; the rest the accent. */
export function toneFor(kind: DrawingKind): Tone {
  if (kind === 'long') return 'up';
  if (kind === 'short') return 'down';
  if (kind === 'text') return 'text';
  return 'accent';
}

/** The stored drawing a finished placement becomes: the default levels of a Fibonacci tool are copied in, to be edited. */
export function makeDrawing(
  id: string,
  kind: DrawingKind,
  points: Pt[],
  extras: { variant?: PatternVariant; text?: string } = {},
): Drawing {
  return {
    id,
    kind,
    points,
    ...(extras.variant ? { variant: extras.variant } : {}),
    ...(kind === 'text' ? { text: extras.text?.trim() || 'Text', size: SIZE_DEFAULT } : {}),
    ...(kind === 'fib' ? { levels: [...FIB_LEVELS] } : {}),
    ...(kind === 'fibExtension' ? { levels: [...EXTENSION_LEVELS] } : {}),
    tone: toneFor(kind),
    locked: false,
    hidden: false,
  };
}

/** A stored drawing's kind, shown in the tree and the toolbar. */
export const KIND_KEYS: readonly DrawingKind[] = [
  'horizontal',
  'ray',
  'vertical',
  'cross',
  'trend',
  'info',
  'text',
  'fib',
  'fibExtension',
  'channel',
  'pitchfork',
  'gannFan',
  'gannBox',
  'pattern',
  'long',
  'short',
  'measure',
  'rectangle',
  'ellipse',
  'brush',
];

/** Why a limit is blank: the owner has not set it, its read is still loading, or the read failed. */
export type CapWhy = 'unset' | 'loading' | 'unavailable';

/** Limits from the owner's settings. A blank limit (null) refuses: no number is assumed, and the reason says why. */
export interface DrawingLimits {
  /** Drawings per workbench and symbol. */
  drawingCap: number | null;
  /** Points per brush stroke. */
  brushPointCap: number | null;
  /** Why drawingCap is blank (used only when it is null). */
  drawingWhy?: CapWhy;
  /** Why brushPointCap is blank (used only when it is null). */
  brushWhy?: CapWhy;
}

export type ModelRefusal =
  | Refusal
  | 'cap-unset'
  | 'cap-loading'
  | 'cap-unavailable'
  | 'cap-reached'
  | 'locked'
  | 'not-found'
  | 'brush-cap-unset'
  | 'brush-cap-loading'
  | 'brush-cap-unavailable'
  | 'outside-bars';

const DRAWING_CAP_REFUSAL: Record<CapWhy, ModelRefusal> = {
  unset: 'cap-unset',
  loading: 'cap-loading',
  unavailable: 'cap-unavailable',
};
const BRUSH_CAP_REFUSAL: Record<CapWhy, ModelRefusal> = {
  unset: 'brush-cap-unset',
  loading: 'brush-cap-loading',
  unavailable: 'brush-cap-unavailable',
};

/** The refusal for a blank drawing limit, or for a blank brush limit. */
export const blankCapRefusal = (why: CapWhy | undefined, brush: boolean): ModelRefusal =>
  (brush ? BRUSH_CAP_REFUSAL : DRAWING_CAP_REFUSAL)[why ?? 'unset'];
export type Result = { doc: DrawingDoc } | { refused: ModelRefusal };

export const isRefused = (r: Result): r is { refused: ModelRefusal } => 'refused' in r;

/** Two consecutive identical points, or three collinear pitchfork points, refuse. */
export function degenerate(kind: DrawingKind, points: readonly Pt[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    if (points[i]!.time === points[i - 1]!.time && points[i]!.price === points[i - 1]!.price) return true;
  }
  if (kind === 'pitchfork' && points.length >= 3 && collinear(points[0]!, points[1]!, points[2]!)) return true;
  return false;
}

export function addDrawing(doc: DrawingDoc, drawing: Drawing, limits: DrawingLimits): Result {
  if (limits.drawingCap === null) return { refused: blankCapRefusal(limits.drawingWhy, false) };
  if (doc.drawings.length >= limits.drawingCap) return { refused: 'cap-reached' };
  if (degenerate(drawing.kind, drawing.points)) return { refused: drawing.kind === 'pitchfork' ? 'collinear' : 'degenerate' };
  return { doc: { ...doc, drawings: [...doc.drawings, drawing] } };
}

export function findDrawing(doc: DrawingDoc, id: string): Drawing | undefined {
  return doc.drawings.find((d) => d.id === id);
}

/** Replace one drawing. A locked drawing refuses every change except its own lock. */
export function patchDrawing(doc: DrawingDoc, id: string, patch: Partial<Drawing>): Result {
  const current = findDrawing(doc, id);
  if (!current) return { refused: 'not-found' };
  if (current.locked && !('locked' in patch) && !('hidden' in patch)) return { refused: 'locked' };
  const next = { ...current, ...patch };
  if (degenerate(next.kind, next.points)) return { refused: 'degenerate' };
  return { doc: { ...doc, drawings: doc.drawings.map((d) => (d.id === id ? next : d)) } };
}

/** Delete one drawing. A locked drawing refuses: unlock it first. */
export function removeDrawing(doc: DrawingDoc, id: string): Result {
  const current = findDrawing(doc, id);
  if (!current) return { refused: 'not-found' };
  if (current.locked) return { refused: 'locked' };
  return { doc: { ...doc, drawings: doc.drawings.filter((d) => d.id !== id) } };
}

/** Clear every drawing and group. Locked drawings are cleared too; the caller asks for confirmation first. */
export function clearAll(doc: DrawingDoc): DrawingDoc {
  return { ...doc, drawings: [], groups: [] };
}

export function setHiddenAll(doc: DrawingDoc, hidden: boolean): DrawingDoc {
  return { ...doc, hiddenAll: hidden };
}

/** Put drawings in a new group. Their existing group, if any, is replaced. */
export function groupDrawings(doc: DrawingDoc, ids: readonly string[], group: Group): Result {
  const members = doc.drawings.filter((d) => ids.includes(d.id));
  if (members.length === 0) return { refused: 'not-found' };
  if (members.some((d) => d.locked)) return { refused: 'locked' };
  return {
    doc: {
      ...doc,
      groups: [...doc.groups.filter((g) => g.id !== group.id), group],
      drawings: doc.drawings.map((d) => (ids.includes(d.id) ? { ...d, groupId: group.id } : d)),
    },
  };
}

export function setGroupHidden(doc: DrawingDoc, groupId: string, hidden: boolean): DrawingDoc {
  return { ...doc, groups: doc.groups.map((g) => (g.id === groupId ? { ...g, hidden } : g)) };
}

/** Whether a drawing is drawn: not hidden itself, not in a hidden group, and the whole chart's hide is off. */
export function isVisible(doc: DrawingDoc, drawing: Drawing): boolean {
  if (doc.hiddenAll || drawing.hidden) return false;
  const group = drawing.groupId ? doc.groups.find((g) => g.id === drawing.groupId) : undefined;
  return !group?.hidden;
}

/**
 * Move every point of a drawing by the same bar and price delta. Bars are moved by index in the loaded bars, so a point
 * is never moved to a time that has no bar. A point that is outside the loaded bars, or a move that would take any point
 * past the first or last loaded bar, refuses as outside the bars: nothing is clamped, so no point collapses onto an edge.
 * Prices move by the decimal delta and are rounded to the tick.
 */
export function shiftPoints(
  points: readonly Pt[],
  barTimes: readonly number[],
  deltaBars: number,
  deltaPrice: Decimal,
  tick: Decimal,
): Pt[] | Refusal {
  const delta = dec(deltaPrice);
  if (delta === null) return 'bad-price';
  const out: Pt[] = [];
  for (const p of points) {
    const from = barIndexAt(barTimes, p.time);
    if (from === null) return 'outside-bars';
    const to = from + deltaBars;
    if (to < 0 || to >= barTimes.length) return 'outside-bars';
    const price = dec(p.price);
    if (price === null) return 'bad-price';
    const moved = roundToTick(add(price, delta), tick);
    if (moved === null) return 'bad-tick';
    out.push({ time: barTimes[to]!, price: moved });
  }
  return out;
}

/**
 * The index of the loaded bar a stored time maps to on the current interval: the nearest bar, when the time lies within the
 * loaded range. A time before the first or after the last loaded bar has no bar here, so it is null (never clamped).
 */
export function barIndexAt(barTimes: readonly number[], time: number): number | null {
  if (barTimes.length === 0) return null;
  if (time < barTimes[0]! || time > barTimes[barTimes.length - 1]!) return null;
  return nearestIndex(barTimes, time);
}

/** The index of the bar at or nearest a time. The loaded bars are sorted by time. */
export function nearestIndex(barTimes: readonly number[], time: number): number {
  let lo = 0;
  let hi = barTimes.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (barTimes[mid]! < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(barTimes[lo - 1]! - time) <= Math.abs(barTimes[lo]! - time)) return lo - 1;
  return lo;
}

/** Parse a stored document from the device. Anything that is not a valid document is dropped whole (the default stands). */
export function parseDoc(value: unknown): DrawingDoc | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<DrawingDoc>;
  if (v.version !== 1 || !Array.isArray(v.drawings) || !Array.isArray(v.groups)) return null;
  const drawings: Drawing[] = [];
  for (const d of v.drawings) {
    const ok = validDrawing(d);
    if (ok) drawings.push(ok);
  }
  const groups = v.groups.filter(
    (g): g is Group =>
      typeof g === 'object' && g !== null && typeof g.id === 'string' && typeof g.name === 'string' && typeof g.hidden === 'boolean',
  );
  return { version: 1, drawings, groups, hiddenAll: v.hiddenAll === true };
}

function validDrawing(value: unknown): Drawing | null {
  if (typeof value !== 'object' || value === null) return null;
  const d = value as Drawing;
  if (typeof d.id !== 'string' || !KIND_KEYS.includes(d.kind) || !TONES.includes(d.tone)) return null;
  if (!Array.isArray(d.points) || d.points.length === 0) return null;
  for (const p of d.points) {
    if (typeof p !== 'object' || p === null || !Number.isInteger(p.time) || dec(p.price) === null) return null;
  }
  if (typeof d.locked !== 'boolean' || typeof d.hidden !== 'boolean') return null;
  return d;
}

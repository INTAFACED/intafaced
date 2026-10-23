/**
 * The render plan: every drawing as canvas-agnostic draw operations in chart pixels, plus its handles and hit geometry.
 * The series primitive draws the plan; the pointer code hit-tests it. Nothing here touches a canvas, so the rules are tested
 * without one. Stored prices become numbers only here, as canvas coordinates.
 *
 * Lines that run to the edge (ray, horizontal, vertical, cross, channel and pitchfork lines, Gann fan rays) are extended
 * from their anchor in their own direction until they leave the plot.
 */
import {
  retracementPrices,
  extensionPrices,
  positionFigures,
  measureFigures,
  gannSlopes,
  FIB_LEVELS,
  EXTENSION_LEVELS,
  type Pt,
} from './geometry';
import { pointsNeeded, SIZE_DEFAULT, type Drawing, type DrawingKind, type Tone } from './model';
import { type Decimal } from './decimal';

export interface View {
  width: number;
  height: number;
  /**
   * Chart x of a stored time: the nearest loaded bar on the current interval, or null when the time lies outside the loaded
   * bars (so it is not drawn, and says so).
   */
  x(time: number): number | null;
  /** Chart y of a decimal price, or null when the chart cannot place it. */
  y(price: Decimal): number | null;
  /** Index of a stored time among the loaded bars (for bar counts), or null outside the loaded bars. */
  indexOf(time: number): number | null;
  tick: Decimal;
  /** The copy catalogue for the labels drawn on the canvas. */
  t(key: string, vars?: Record<string, string>): string;
}

export type Op =
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; tone: Tone; width: number; dash?: boolean }
  | { op: 'poly'; pts: Array<[number, number]>; tone: Tone; width: number }
  | { op: 'rect'; x: number; y: number; w: number; h: number; tone: Tone; width: number; fill?: boolean }
  | { op: 'ellipse'; cx: number; cy: number; rx: number; ry: number; tone: Tone; width: number; fill?: boolean }
  | { op: 'text'; x: number; y: number; text: string; tone: Tone; size: number; bold?: boolean }
  | { op: 'dot'; x: number; y: number; tone: Tone };

export interface Handle {
  x: number;
  y: number;
  /** A point index, or 'middle' for the midpoint of a two-point drawing (dragging it moves the whole drawing). */
  index: number | 'middle';
}

export interface Plan {
  id: string;
  ops: Op[];
  handles: Handle[];
  /** Why a drawing is not drawn as stored (a refusal the person can read); empty when it draws. */
  note: string | null;
}

type Xy = { x: number; y: number };

/** Where a line from `a` in the direction of `b` leaves the plot: the far point of the ray within the box, or null. */
export function extendFrom(a: Xy, b: Xy, width: number, height: number): Xy | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return null;
  let s = Number.POSITIVE_INFINITY;
  if (dx > 0) s = Math.min(s, (width - a.x) / dx);
  if (dx < 0) s = Math.min(s, -a.x / dx);
  if (dy > 0) s = Math.min(s, (height - a.y) / dy);
  if (dy < 0) s = Math.min(s, -a.y / dy);
  if (!Number.isFinite(s)) return null;
  return { x: a.x + dx * s, y: a.y + dy * s };
}

/** Chart coordinates of each stored point, or null when any point has no place on the chart yet. */
function coords(points: readonly Pt[], view: View): Xy[] | null {
  const out: Xy[] = [];
  for (const p of points) {
    const x = view.x(p.time);
    const y = view.y(p.price);
    if (x === null || y === null) return null;
    out.push({ x, y });
  }
  return out;
}

const bodyOps = (d: Drawing, view: View, xy: Xy[]): { ops: Op[]; note: string | null } => {
  const ops: Op[] = [];
  const tone = d.tone;
  const W = view.width;
  const H = view.height;
  const line = (a: Xy, b: Xy, width = 1.5, dash = false): Op => ({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, tone, width, dash });
  const ray = (a: Xy, b: Xy): Xy => extendFrom(a, b, W, H) ?? b;
  const figuresLabel = (text: string, at: Xy): Op => ({ op: 'text', x: at.x + 6, y: at.y - 6, text, tone, size: 12 });
  const [p0, p1, p2] = xy;

  switch (d.kind) {
    case 'horizontal':
      ops.push({ op: 'line', x1: 0, y1: p0!.y, x2: W, y2: p0!.y, tone, width: 1.5 });
      break;
    case 'vertical':
      ops.push({ op: 'line', x1: p0!.x, y1: 0, x2: p0!.x, y2: H, tone, width: 1.5 });
      break;
    case 'cross':
      ops.push({ op: 'line', x1: 0, y1: p0!.y, x2: W, y2: p0!.y, tone, width: 1 });
      ops.push({ op: 'line', x1: p0!.x, y1: 0, x2: p0!.x, y2: H, tone, width: 1 });
      break;
    case 'text':
      ops.push({ op: 'text', x: p0!.x, y: p0!.y, text: d.text ?? '', tone, size: d.size ?? SIZE_DEFAULT, bold: false });
      break;
    case 'ray':
      if (p1) ops.push(line(p0!, ray(p0!, p1)));
      break;
    case 'trend':
      if (p1) ops.push(line(p0!, p1));
      break;
    case 'info': {
      if (!p1) break;
      ops.push(line(p0!, p1));
      const m = measureFigures(d.points[0]!, d.points[1]!, view.tick, view.indexOf);
      if (typeof m === 'object') {
        ops.push(figuresLabel(view.t('Measure bars {count}', { count: String(m.bars) }), { x: (p0!.x + p1.x) / 2, y: (p0!.y + p1.y) / 2 }));
        if (m.pct !== null)
          ops.push(
            figuresLabel(view.t('Measure change {diff} {pct}', { diff: m.priceDiff, pct: m.pct }), {
              x: (p0!.x + p1.x) / 2,
              y: (p0!.y + p1.y) / 2 + 16,
            }),
          );
      }
      break;
    }
    case 'measure': {
      if (!p1) break;
      const box = rectOf(p0!, p1);
      ops.push({ op: 'rect', ...box, tone, width: 1, fill: true });
      const m = measureFigures(d.points[0]!, d.points[1]!, view.tick, view.indexOf);
      if (typeof m === 'object') {
        const at = { x: box.x + 6, y: box.y + 14 };
        ops.push({ op: 'text', x: at.x, y: at.y, text: view.t('Measure bars {count}', { count: String(m.bars) }), tone, size: 12 });
        ops.push({ op: 'text', x: at.x, y: at.y + 16, text: view.t('Measure price {diff}', { diff: m.priceDiff }), tone, size: 12 });
        ops.push({ op: 'text', x: at.x, y: at.y + 32, text: view.t('Measure span {span}', { span: m.span }), tone, size: 12 });
      }
      break;
    }
    case 'fib': {
      if (!p1) break;
      const levels = retracementPrices(d.points[0]!, d.points[1]!, d.levels ?? FIB_LEVELS, view.tick);
      if (typeof levels === 'string') return { ops, note: view.t('Levels refused') };
      const left = Math.min(p0!.x, p1.x);
      ops.push(line(p0!, p1, 1, true));
      for (const level of levels) {
        const y = view.y(level.price);
        if (y === null) continue;
        ops.push({ op: 'line', x1: left, y1: y, x2: W, y2: y, tone, width: 1 });
        ops.push({ op: 'text', x: left + 4, y: y - 4, text: `${level.level}  ${level.price}`, tone, size: 11 });
      }
      break;
    }
    case 'fibExtension': {
      if (!p2) break;
      const levels = extensionPrices(d.points[0]!, d.points[1]!, d.points[2]!, d.levels ?? EXTENSION_LEVELS, view.tick);
      if (typeof levels === 'string') return { ops, note: view.t('Levels refused') };
      ops.push(line(p0!, p1!, 1, true));
      ops.push(line(p1!, p2, 1, true));
      for (const level of levels) {
        const y = view.y(level.price);
        if (y === null) continue;
        ops.push({ op: 'line', x1: p2.x, y1: y, x2: W, y2: y, tone, width: 1 });
        ops.push({ op: 'text', x: p2.x + 4, y: y - 4, text: `${level.level}  ${level.price}`, tone, size: 11 });
      }
      break;
    }
    case 'channel': {
      if (!p2) break;
      // Parallel lines: the base line through the first two points, and the line through the third with the same direction.
      const base = ray(p0!, p1!);
      ops.push(line(p0!, base));
      const dx = p1!.x - p0!.x;
      const dy = p1!.y - p0!.y;
      const far = extendFrom(p2, { x: p2.x + dx, y: p2.y + dy }, W, H) ?? p2;
      ops.push(line(p2, far));
      ops.push(line(p0!, p2, 0.5, true));
      break;
    }
    case 'pitchfork': {
      if (!p2) break;
      // Andrews: the median from the first point through the midpoint of the second and third; tines through them, parallel.
      const mid = { x: (p1!.x + p2.x) / 2, y: (p1!.y + p2.y) / 2 };
      const median = ray(p0!, mid);
      ops.push(line(p0!, median));
      const dx = mid.x - p0!.x;
      const dy = mid.y - p0!.y;
      ops.push(line(p1!, extendFrom(p1!, { x: p1!.x + dx, y: p1!.y + dy }, W, H) ?? p1!));
      ops.push(line(p2, extendFrom(p2, { x: p2.x + dx, y: p2.y + dy }, W, H) ?? p2));
      break;
    }
    case 'gannFan': {
      if (!p1) break;
      const slopes = gannSlopes(d.points[0]!, d.points[1]!, view.tick, view.indexOf);
      if (typeof slopes === 'string') return { ops, note: view.t('Fan refused') };
      const dir = p1.x >= p0!.x ? 1 : -1;
      const xEnd = dir > 0 ? W : 0;
      const base = p1.x === p0!.x ? 0 : (p1.y - p0!.y) / (p1.x - p0!.x);
      for (const r of slopes) {
        const ratio = Number(r.ratio);
        const yEnd = p0!.y + base * ratio * (xEnd - p0!.x);
        ops.push({ op: 'line', x1: p0!.x, y1: p0!.y, x2: xEnd, y2: yEnd, tone, width: r.ratio === '1' ? 1.5 : 1 });
      }
      break;
    }
    case 'gannBox': {
      if (!p1) break;
      const box = rectOf(p0!, p1);
      ops.push({ op: 'rect', ...box, tone, width: 1 });
      ops.push(line(p0!, p1, 1, true));
      ops.push({ op: 'line', x1: box.x, y1: box.y + box.h / 2, x2: box.x + box.w, y2: box.y + box.h / 2, tone, width: 0.5 });
      ops.push({ op: 'line', x1: box.x + box.w / 2, y1: box.y, x2: box.x + box.w / 2, y2: box.y + box.h, tone, width: 0.5 });
      break;
    }
    case 'pattern': {
      const letters = d.variant === 'xabcd' ? 'XABCD' : 'ABCD';
      ops.push({ op: 'poly', pts: xy.map((p) => [p.x, p.y]), tone, width: 1.5 });
      xy.forEach((p, i) => ops.push({ op: 'text', x: p.x + 4, y: p.y - 6, text: letters[i] ?? '', tone, size: 12, bold: true }));
      break;
    }
    case 'long':
    case 'short': {
      if (!p2) break;
      const right = Math.max(p0!.x, p1!.x, p2.x);
      const left = Math.min(p0!.x, p1!.x, p2.x);
      const figures = positionFigures(d.kind, d.points[0]!, d.points[1]!, d.points[2]!, view.tick);
      // Points are ordered entry, stop, target. Profit lies on the target's side of the entry, loss on the stop's side.
      const profit = p2.y;
      const loss = p1!.y;
      const top = Math.min(p0!.y, p1!.y, p2.y);
      const bottom = Math.max(p0!.y, p1!.y, p2.y);
      ops.push({ op: 'rect', x: left, y: top, w: right - left, h: bottom - top, tone, width: 0.5, fill: false });
      ops.push({
        op: 'rect',
        x: p0!.x,
        y: Math.min(profit, p0!.y),
        w: right - p0!.x,
        h: Math.abs(p0!.y - profit),
        tone: 'up',
        width: 0,
        fill: true,
      });
      ops.push({
        op: 'rect',
        x: p0!.x,
        y: Math.min(loss, p0!.y),
        w: right - p0!.x,
        h: Math.abs(p0!.y - loss),
        tone: 'down',
        width: 0,
        fill: true,
      });
      ops.push(line(p0!, { x: right, y: p0!.y }, 1, false));
      const label = typeof figures === 'string' ? view.t('Wrong side') : view.t('Risk and reward {ratio}', { ratio: figures.ratio });
      ops.push({ op: 'text', x: right + 4, y: p0!.y - 4, text: label, tone, size: 12 });
      if (typeof figures !== 'string') {
        ops.push({
          op: 'text',
          x: right + 4,
          y: profit - 4,
          text: view.t('Target {price}', { price: figures.target }),
          tone: 'up',
          size: 11,
        });
        ops.push({ op: 'text', x: right + 4, y: loss + 12, text: view.t('Stop {price}', { price: figures.stop }), tone: 'down', size: 11 });
      }
      return { ops, note: typeof figures === 'string' ? view.t('Stop and target must sit on the right side of the entry') : null };
    }
    case 'rectangle': {
      if (!p1) break;
      ops.push({ op: 'rect', ...rectOf(p0!, p1), tone, width: 1.5, fill: false });
      break;
    }
    case 'ellipse': {
      if (!p1) break;
      const box = rectOf(p0!, p1);
      ops.push({ op: 'ellipse', cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: box.w / 2, ry: box.h / 2, tone, width: 1.5 });
      break;
    }
    case 'brush':
      ops.push({ op: 'poly', pts: xy.map((p) => [p.x, p.y]), tone, width: 2 });
      break;
    default:
      break;
  }
  return { ops, note: null };
};

function rectOf(a: Xy, b: Xy): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** Two-point drawings get a handle on their midpoint, so the whole drawing moves from one handle. */
const MIDDLE_HANDLE: ReadonlySet<DrawingKind> = new Set(['trend', 'info', 'ray', 'measure', 'rectangle', 'ellipse', 'gannBox']);

/**
 * The plan of one drawing. A drawing with a point outside the loaded bars is not drawn, and its plan says so; nothing is
 * drawn for it in silence.
 */
export function planDrawing(d: Drawing, view: View, options: { selected?: boolean } = {}): Plan {
  const xy = coords(d.points, view);
  if (!xy) {
    const outside = d.points.some((p) => view.x(p.time) === null);
    return { id: d.id, ops: [], handles: [], note: outside ? view.t('Outside the loaded bars') : null };
  }
  if (xy.length < pointsNeeded(d.kind, d.variant)) return { id: d.id, ops: [], handles: [], note: null };
  const { ops, note } = bodyOps(d, view, xy);
  const handles: Handle[] = [];
  if (options.selected) {
    xy.forEach((p, index) => handles.push({ x: p.x, y: p.y, index }));
    if (MIDDLE_HANDLE.has(d.kind) && xy.length === 2) {
      handles.push({ x: (xy[0]!.x + xy[1]!.x) / 2, y: (xy[0]!.y + xy[1]!.y) / 2, index: 'middle' });
    }
    for (const h of handles) ops.push({ op: 'dot', x: h.x, y: h.y, tone: 'accent' });
  }
  return { id: d.id, ops, handles, note };
}

export interface Hit {
  id: string;
  /** The handle grabbed, when a handle was hit; otherwise the body of the drawing. */
  handle?: number | 'middle';
}

const HANDLE_RADIUS = 7;
const LINE_SLOP = 6;

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * The drawing under a pointer, top-most first (the plans are in drawing order, so the last one wins). A handle wins over the
 * body of its own drawing.
 */
export function hitTest(plans: readonly Plan[], px: number, py: number): Hit | null {
  for (let i = plans.length - 1; i >= 0; i -= 1) {
    const plan = plans[i]!;
    for (const h of plan.handles) {
      if (Math.hypot(h.x - px, h.y - py) <= HANDLE_RADIUS) return { id: plan.id, handle: h.index };
    }
  }
  for (let i = plans.length - 1; i >= 0; i -= 1) {
    const plan = plans[i]!;
    for (const op of plan.ops) {
      if (op.op === 'line' && distanceToSegment(px, py, op.x1, op.y1, op.x2, op.y2) <= LINE_SLOP) return { id: plan.id };
      if (op.op === 'poly') {
        for (let k = 1; k < op.pts.length; k += 1) {
          const [ax, ay] = op.pts[k - 1]!;
          const [bx, by] = op.pts[k]!;
          if (distanceToSegment(px, py, ax, ay, bx, by) <= LINE_SLOP) return { id: plan.id };
        }
      }
      if (op.op === 'rect') {
        const inside = px >= op.x - LINE_SLOP && px <= op.x + op.w + LINE_SLOP && py >= op.y - LINE_SLOP && py <= op.y + op.h + LINE_SLOP;
        const edge = op.fill
          ? false
          : Math.min(Math.abs(px - op.x), Math.abs(px - op.x - op.w), Math.abs(py - op.y), Math.abs(py - op.y - op.h)) <= LINE_SLOP;
        if (inside && (op.fill || edge)) return { id: plan.id };
      }
      if (op.op === 'text') {
        const w = Math.max(20, op.text.length * op.size * 0.6);
        if (px >= op.x && px <= op.x + w && py >= op.y - op.size && py <= op.y + 4) return { id: plan.id };
      }
    }
  }
  return null;
}

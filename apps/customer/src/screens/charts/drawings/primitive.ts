/**
 * The series primitive that draws the drawings on the chart's price pane (Lightweight Charts 5 `ISeriesPrimitive`). It is
 * attached to the workbench's main series, so the drawings move with pan, zoom and interval changes: they are re-planned on
 * every paint from their stored bar times and decimal prices. The primitive knows nothing about pointers; the hook asks it
 * what is under a pixel (`hit`).
 */
import { planDrawing, hitTest, type Hit, type Op, type Plan, type View } from './render';
import type { Drawing } from './model';
import type { Decimal } from './decimal';

export interface PrimitiveState {
  /** Drawings to paint, in order (the last is on top). Hidden drawings are not passed. */
  drawings: readonly Drawing[];
  selectedId: string | null;
  /** A drawing being placed, painted dimmed and never hit-tested. */
  preview: Drawing | null;
  tick: Decimal;
  indexOf(time: number): number;
  t(key: string, vars?: Record<string, string>): string;
}

interface SeriesLike {
  priceToCoordinate(price: number): number | null;
}
interface ChartLike {
  timeScale(): { timeToCoordinate(time: number): number | null };
}
interface PaintTarget {
  useMediaCoordinateSpace(
    scope: (input: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => void,
  ): void;
}

/** Token names for each tone (`--if-*`, from the app's theme). A missing token paints in the current colour. */
const TONE_TOKEN = { accent: '--if-lime', up: '--if-up', down: '--if-down', text: '--if-fg-2' } as const;

export class DrawingsPrimitive {
  private state: PrimitiveState | null = null;
  private series: SeriesLike | null = null;
  private chart: ChartLike | null = null;
  private update: (() => void) | null = null;
  private plans: Plan[] = [];
  private size = { width: 0, height: 0 };

  /** Lightweight Charts calls this when the primitive joins a series. */
  attached(param: { chart: unknown; series?: unknown; requestUpdate: () => void }): void {
    this.chart = param.chart as ChartLike;
    this.series = (param.series as SeriesLike | undefined) ?? this.series;
    this.update = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.update = null;
    this.plans = [];
  }

  /** Bind the series when the chart attaches without passing one (the hook does this from the host). */
  bind(series: SeriesLike): void {
    this.series = series;
  }

  set(state: PrimitiveState | null): void {
    this.state = state;
    this.update?.();
  }

  /** Plans as last painted: what the pointer code hit-tests against. */
  current(): readonly Plan[] {
    return this.plans;
  }

  hit(x: number, y: number): Hit | null {
    return hitTest(this.plans, x, y);
  }

  /** The chart's pixel size as last painted (the extended lines run to its edges). */
  paintedSize(): { width: number; height: number } {
    return this.size;
  }

  paneViews() {
    return [
      {
        zOrder: () => 'normal' as const,
        renderer: () => ({ draw: (target: PaintTarget) => this.paint(target) }),
        update: () => undefined,
      },
    ];
  }

  updateAllViews(): void {
    // Plans are rebuilt in `paint`, where the pane size is known; nothing to do here.
  }

  private viewFor(width: number, height: number, state: PrimitiveState): View | null {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return null;
    const timeScale = chart.timeScale();
    return {
      width,
      height,
      x: (time) => timeScale.timeToCoordinate(time),
      y: (price) => {
        const value = Number(price);
        return Number.isFinite(value) ? series.priceToCoordinate(value) : null;
      },
      indexOf: state.indexOf,
      tick: state.tick,
      t: state.t,
    };
  }

  private paint(target: PaintTarget): void {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      this.size = { width: mediaSize.width, height: mediaSize.height };
      const state = this.state;
      this.plans = [];
      if (!state) return;
      const view = this.viewFor(mediaSize.width, mediaSize.height, state);
      if (!view) return;
      const colours = readTones();
      const plans: Plan[] = [];
      for (const drawing of state.drawings) {
        plans.push(planDrawing(drawing, view, { selected: drawing.id === state.selectedId }));
      }
      this.plans = plans;
      for (const plan of plans) for (const op of plan.ops) paintOp(context, op, colours);
      if (state.preview) {
        const preview = planDrawing(state.preview, view, { selected: false });
        context.globalAlpha = 0.6;
        for (const op of preview.ops) paintOp(context, op, colours);
        context.globalAlpha = 1;
      }
    });
  }
}

function readTones(): Record<keyof typeof TONE_TOKEN, string> {
  const css = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const read = (token: string) => css?.getPropertyValue(token).trim() || 'currentColor';
  return {
    accent: read(TONE_TOKEN.accent),
    up: read(TONE_TOKEN.up),
    down: read(TONE_TOKEN.down),
    text: read(TONE_TOKEN.text),
  };
}

function paintOp(ctx: CanvasRenderingContext2D, op: Op, colours: Record<keyof typeof TONE_TOKEN, string>): void {
  const colour = colours[op.tone];
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  switch (op.op) {
    case 'line':
      ctx.lineWidth = op.width;
      ctx.setLineDash(op.dash ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    case 'poly':
      if (op.pts.length < 2) break;
      ctx.lineWidth = op.width;
      ctx.beginPath();
      ctx.moveTo(op.pts[0]![0], op.pts[0]![1]);
      for (const [x, y] of op.pts.slice(1)) ctx.lineTo(x, y);
      ctx.stroke();
      break;
    case 'rect':
      if (op.fill) {
        ctx.globalAlpha = 0.12;
        ctx.fillRect(op.x, op.y, op.w, op.h);
        ctx.globalAlpha = 1;
      } else {
        ctx.lineWidth = op.width;
        ctx.strokeRect(op.x, op.y, op.w, op.h);
      }
      break;
    case 'ellipse':
      ctx.lineWidth = op.width;
      ctx.beginPath();
      ctx.ellipse(op.cx, op.cy, Math.max(0, op.rx), Math.max(0, op.ry), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'text':
      ctx.font = `${op.bold ? '600 ' : ''}${op.size}px system-ui, sans-serif`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(op.text, op.x, op.y);
      break;
    case 'dot':
      ctx.beginPath();
      ctx.arc(op.x, op.y, 4, 0, Math.PI * 2);
      ctx.fill();
      break;
    default:
      break;
  }
}

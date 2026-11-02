import { describe, expect, it } from 'vitest';
import { keyedRange, viewKeys, type LogicalRange, type ViewScale } from './chart-keys';

/** What a fit shows in these cases: every bar and the right offset. */
const FITTED: LogicalRange = { from: -1, to: 216 };

/**
 * A stand-in for the library's time scale with its timing: an asked range, or a fit, is applied on the next frame (the
 * last one asked wins), and reads report the drawn range until then. `leftmost` clamps a range the way the library keeps
 * bars in view at the left end.
 */
function fakeChart(start: LogicalRange, leftmost = -Infinity) {
  let drawn: LogicalRange = start;
  let pending: LogicalRange | null = null;
  let fitted = false;
  let callbacks: (() => void)[] = [];
  const scale: ViewScale = {
    getVisibleLogicalRange: () => drawn,
    setVisibleLogicalRange: (range) => {
      pending = range;
    },
    fitContent: () => {
      fitted = true;
      pending = FITTED;
    },
  };
  return {
    scale,
    nextFrame: (run: () => void) => void callbacks.push(run),
    /** One animation frame: the library draws what was asked first, then the callbacks asked after it run. */
    frame() {
      if (pending) {
        const shift = Math.max(0, leftmost - pending.from);
        drawn = { from: pending.from + shift, to: pending.to + shift };
        pending = null;
      }
      const run = callbacks;
      callbacks = [];
      for (const callback of run) callback();
    },
    drawn: () => drawn,
    fitted: () => fitted,
  };
}

describe('chart view keys', () => {
  it('pans twenty bars on two presses of ← in one frame, not ten from the stale range', () => {
    const chart = fakeChart({ from: 40, to: 216 });
    const key = viewKeys(chart.nextFrame);
    expect(key(chart.scale, 'ArrowLeft')).toBe(true);
    expect(key(chart.scale, 'ArrowLeft')).toBe(true);
    chart.frame();
    expect(chart.drawn()).toEqual({ from: 20, to: 196 });
  });

  it('pans the same on two presses in separate frames', () => {
    const chart = fakeChart({ from: 40, to: 216 });
    const key = viewKeys(chart.nextFrame);
    key(chart.scale, 'ArrowLeft');
    chart.frame();
    key(chart.scale, 'ArrowLeft');
    chart.frame();
    expect(chart.drawn()).toEqual({ from: 20, to: 196 });
  });

  it('zooms out from the zoom asked in the same frame, around the right edge', () => {
    const chart = fakeChart({ from: 16, to: 216 });
    const key = viewKeys(chart.nextFrame);
    key(chart.scale, '+');
    key(chart.scale, '-');
    chart.frame();
    expect(chart.drawn().to).toBe(216);
    expect(chart.drawn().from).toBeCloseTo(16);
  });

  it('starts from the drawn range after a frame, so a range the chart clamped is not built on', () => {
    // At the left end the chart keeps its view where it is; a press of → afterwards moves it from there at once.
    const chart = fakeChart({ from: 0, to: 176 }, 0);
    const key = viewKeys(chart.nextFrame);
    key(chart.scale, 'ArrowLeft');
    chart.frame();
    expect(chart.drawn()).toEqual({ from: 0, to: 176 });
    key(chart.scale, 'ArrowRight');
    chart.frame();
    expect(chart.drawn()).toEqual({ from: 10, to: 186 });
  });

  it('shows the newest bars on Home, and a key pressed before the fit is drawn moves the fitted view', () => {
    const chart = fakeChart({ from: 0, to: 100 });
    const key = viewKeys(chart.nextFrame);
    key(chart.scale, 'ArrowLeft');
    expect(key(chart.scale, 'Home')).toBe(true);
    expect(key(chart.scale, 'ArrowLeft')).toBe(true);
    expect(chart.fitted()).toBe(true);
    chart.frame();
    // The fit is drawn, then the waiting ← is asked from it; the pan before Home is not built on.
    expect(chart.drawn()).toEqual(FITTED);
    chart.frame();
    expect(chart.drawn()).toEqual({ from: -11, to: 206 });
  });

  it('leaves other keys and a chart with no range alone', () => {
    const chart = fakeChart({ from: 40, to: 216 });
    const key = viewKeys(chart.nextFrame);
    expect(key(chart.scale, 'a')).toBe(false);
    expect(key({ ...chart.scale, getVisibleLogicalRange: () => null }, 'ArrowLeft')).toBe(false);
    chart.frame();
    expect(chart.drawn()).toEqual({ from: 40, to: 216 });
  });

  it('pans ten bars and zooms by a fifth, at least ten bars wide', () => {
    expect(keyedRange('ArrowRight', { from: 0, to: 100 })).toEqual({ from: 10, to: 110 });
    expect(keyedRange('+', { from: 0, to: 100 })).toEqual({ from: 20, to: 100 });
    expect(keyedRange('=', { from: 95, to: 100 })).toEqual({ from: 90, to: 100 });
    expect(keyedRange('_', { from: 20, to: 100 })).toEqual({ from: 0, to: 100 });
    expect(keyedRange('Enter', { from: 0, to: 100 })).toBeNull();
  });
});

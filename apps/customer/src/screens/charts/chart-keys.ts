/**
 * The chart's view keys: the arrows pan by ten bars, + and - zoom around the right edge, Home shows the newest bars again.
 *
 * The chart library applies a new visible range on its next animation frame and reports the old one until then. So a key
 * pressed in the same frame as the one before it starts from the range that key asked for, never from the stale one:
 * otherwise two quick presses of ← pan ten bars, not twenty (J-charts-desk-08 #6, Real-app journeys runs 1120, 1131 and
 * 1138, #7090).
 */
export interface LogicalRange {
  from: number;
  to: number;
}

/** The part of the library's time scale the keys use. */
export interface ViewScale {
  getVisibleLogicalRange(): LogicalRange | null;
  setVisibleLogicalRange(range: LogicalRange): void;
  fitContent(): void;
}

export const PAN_BARS = 10;
const VIEW_KEYS = new Set(['ArrowLeft', 'ArrowRight', '+', '=', '-', '_', 'Home']);

/** The range a view key asks for from `range`; null for any other key. */
export function keyedRange(key: string, range: LogicalRange): LogicalRange | null {
  const width = range.to - range.from;
  if (key === 'ArrowLeft') return { from: range.from - PAN_BARS, to: range.to - PAN_BARS };
  if (key === 'ArrowRight') return { from: range.from + PAN_BARS, to: range.to + PAN_BARS };
  if (key === '+' || key === '=') return { from: range.to - Math.max(10, width * 0.8), to: range.to };
  if (key === '-' || key === '_') return { from: range.to - width * 1.25, to: range.to };
  return null;
}

/**
 * One chart's view keys. `nextFrame` runs after the library's own frame (it is asked for later, and frame callbacks run in
 * the order asked), so by then the chart reports the range it drew, clamped or not, and the asked range is let go.
 * Home's fit is drawn on that frame too, so a key pressed before then waits for it and moves the fitted view.
 * Returns whether the key was a view key, so the caller can keep it from scrolling the page.
 */
export function viewKeys(nextFrame: (run: () => void) => void) {
  let asked: LogicalRange | null = null;
  let fitting = false;
  const press = (scale: ViewScale, key: string): boolean => {
    if (!VIEW_KEYS.has(key)) return false;
    if (fitting) {
      nextFrame(() => press(scale, key));
      return true;
    }
    const range = asked ?? scale.getVisibleLogicalRange();
    if (!range) return false;
    if (key === 'Home') {
      asked = null;
      fitting = true;
      scale.fitContent();
      nextFrame(() => {
        fitting = false;
      });
      return true;
    }
    const next = keyedRange(key, range)!;
    scale.setVisibleLogicalRange(next);
    asked = next;
    nextFrame(() => {
      if (asked === next) asked = null;
    });
    return true;
  };
  return press;
}

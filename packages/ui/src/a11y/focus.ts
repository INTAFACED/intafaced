/**
 * Focus not obscured (WCAG 2.2 SC 2.4.11). The fixed risk band, the top bar and the phone dock cover
 * part of the page; a control that takes focus under them must scroll clear. a11y.css turns the heights
 * below into scroll-padding, which browsers use when they scroll a focused element into view; trackObscuringBars also
 * scrolls a control that takes focus already on screen but under a bar, which browsers leave where it is.
 *
 * A fixed bar says which edge it covers with `data-obscures="top"` or `data-obscures="bottom"`. Their
 * real heights are measured, not assumed, because the risk band grows with text size (200% text must
 * not hide the field under it).
 */

export const OBSCURES_ATTRIBUTE = 'data-obscures';
export const OBSCURED_TOP_VAR = '--a11y-obscured-top';
export const OBSCURED_BOTTOM_VAR = '--a11y-obscured-bottom';

export interface Bar {
  readonly edge: string | null;
  readonly height: number;
  /**
   * A fixed bar's reach: from its edge of the screen to its far side, so a bar that floats off the edge (the phone
   * dock sits 0.875rem above the bottom) covers its gap too. Absent for a bar in the page's flow (the sticky risk
   * band, which stacks under the top bar), which covers its height.
   */
  readonly reach?: number;
}

const size = (n: number | undefined): number => (n !== undefined && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * The space covered at each edge: the furthest reach of the fixed bars there, and the heights of the bars in the
 * page's flow stacked under them.
 */
export function obscuredInsets(bars: Iterable<Bar>): { top: number; bottom: number } {
  const edges = { top: { reach: 0, stacked: 0 }, bottom: { reach: 0, stacked: 0 } };
  for (const bar of bars) {
    if (bar.edge !== 'top' && bar.edge !== 'bottom') continue;
    const at = edges[bar.edge];
    if (bar.reach === undefined) at.stacked += size(bar.height);
    else at.reach = Math.max(at.reach, size(bar.reach));
  }
  return { top: edges.top.reach + edges.top.stacked, bottom: edges.bottom.reach + edges.bottom.stacked };
}

/** One bar as measured now: its edge, height and, when it is fixed, its reach from that edge. */
function measureBar(el: HTMLElement): Bar {
  const edge = el.getAttribute(OBSCURES_ATTRIBUTE);
  const box = el.getBoundingClientRect();
  if (getComputedStyle(el).position !== 'fixed') return { edge, height: box.height };
  const reach = edge === 'bottom' ? window.innerHeight - box.top : box.bottom;
  return { edge, height: box.height, reach };
}

/** Space kept between a focused control and a bar that would cover it, so its focus ring shows too. */
export const FOCUS_CLEARANCE = 8;

/**
 * Whether a newly focused element should be scrolled clear of the bars: only keyboard focus (`:focus-visible`), which is
 * what SC 2.4.11 covers. A press with the mouse or a finger focuses a control under the pointer; scrolling then would move
 * it out from under a drag that has just started (the chart's drawing handles, J-charts-desk-06 #4).
 */
export function clearsFocus(el: { matches(selector: string): boolean; closest(selector: string): unknown }): boolean {
  if (el.closest(`[${OBSCURES_ATTRIBUTE}]`)) return false;
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

/**
 * How far to scroll so a focused box clears the bars: positive scrolls down (the box is under a bottom bar), negative up
 * (under a top bar), 0 when it is clear. `topEdge` is where the top bars end, `bottomEdge` where the bottom bars start,
 * both in viewport pixels from each bar's own box, so a floating bar's offset from the edge counts. A box taller than the
 * space between them keeps its top in view.
 */
export function focusScroll(
  box: { top: number; bottom: number },
  { topEdge, bottomEdge }: { topEdge: number; bottomEdge: number },
  gap = FOCUS_CLEARANCE,
): number {
  if (box.top < topEdge + gap) return box.top - topEdge - gap;
  if (box.bottom > bottomEdge - gap) return Math.min(box.bottom - bottomEdge + gap, box.top - topEdge - gap);
  return 0;
}

/**
 * Keep the two custom properties on `root` equal to the space the bars really cover, as bars come, go and
 * resize. Returns the function that stops it. Does nothing where there is no DOM.
 */
export function trackObscuringBars(root: HTMLElement = document.documentElement): () => void {
  if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return () => {};

  let bars: HTMLElement[] = [];
  let last = '';
  const measure = (): void => {
    const { top, bottom } = obscuredInsets(bars.map(measureBar));
    const next = `${top}|${bottom}`;
    if (next === last) return;
    last = next;
    root.style.setProperty(OBSCURED_TOP_VAR, `${top}px`);
    root.style.setProperty(OBSCURED_BOTTOM_VAR, `${bottom}px`);
  };

  const resize = new ResizeObserver(measure);
  const observeBars = (): void => {
    resize.disconnect();
    bars = Array.from(root.querySelectorAll<HTMLElement>(`[${OBSCURES_ATTRIBUTE}]`));
    for (const el of bars) resize.observe(el);
    measure();
  };
  // Live tickers change the DOM many times a second: re-scan only when a bar itself comes, goes or
  // changes edge, never for other nodes.
  const touchesBar = (node: Node): boolean =>
    node instanceof Element && (node.hasAttribute(OBSCURES_ATTRIBUTE) || node.querySelector(`[${OBSCURES_ATTRIBUTE}]`) !== null);
  const mutations = new MutationObserver((records) => {
    const relevant = records.some(
      (record) => record.type === 'attributes' || [...record.addedNodes].some(touchesBar) || [...record.removedNodes].some(touchesBar),
    );
    if (relevant) observeBars();
  });
  mutations.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: [OBSCURES_ATTRIBUTE] });
  // A fixed bar's reach moves with the screen (a turned phone, the safe area) while its size stays.
  window.addEventListener('resize', measure);
  observeBars();

  // Browsers do not use scroll-padding when keyboard focus moves to a control that is already inside the viewport, so a
  // control under the dock stays there (Chromium, look gate on /trade/calendar at 200% text). Scroll it clear here.
  const clearFocus = (event: FocusEvent): void => {
    const el = event.target;
    if (!(el instanceof Element) || bars.length === 0 || !clearsFocus(el)) return;
    let topEdge = 0;
    let bottomEdge = window.innerHeight;
    for (const bar of bars) {
      const r = bar.getBoundingClientRect();
      if (r.height <= 0) continue;
      const edge = bar.getAttribute(OBSCURES_ATTRIBUTE);
      if (edge === 'top') topEdge = Math.max(topEdge, r.bottom);
      else if (edge === 'bottom') bottomEdge = Math.min(bottomEdge, r.top);
    }
    const dy = focusScroll(el.getBoundingClientRect(), { topEdge, bottomEdge });
    if (dy !== 0) window.scrollBy({ top: dy, behavior: 'instant' });
  };
  root.ownerDocument.addEventListener('focusin', clearFocus);

  return () => {
    window.removeEventListener('resize', measure);
    root.ownerDocument.removeEventListener('focusin', clearFocus);
    mutations.disconnect();
    resize.disconnect();
    root.style.removeProperty(OBSCURED_TOP_VAR);
    root.style.removeProperty(OBSCURED_BOTTOM_VAR);
  };
}

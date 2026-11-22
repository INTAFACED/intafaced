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
}

/** The space covered at each edge: bars stack, so their heights add up. */
export function obscuredInsets(bars: Iterable<Bar>): { top: number; bottom: number } {
  let top = 0;
  let bottom = 0;
  for (const bar of bars) {
    const height = Number.isFinite(bar.height) && bar.height > 0 ? bar.height : 0;
    if (bar.edge === 'top') top += height;
    else if (bar.edge === 'bottom') bottom += height;
  }
  return { top, bottom };
}

/** Space kept between a focused control and a bar that would cover it, so its focus ring shows too. */
export const FOCUS_CLEARANCE = 8;

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

/** Whether `el` shows keyboard focus; where the browser cannot tell (no `:focus-visible`), it counts as keyboard focus. */
export function focusIsVisible(el: { matches(selectors: string): boolean }): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Keep the two custom properties on `root` equal to the bars' real heights, as bars come, go and
 * resize. Returns the function that stops it. Does nothing where there is no DOM.
 */
export function trackObscuringBars(root: HTMLElement = document.documentElement): () => void {
  if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return () => {};

  let bars: HTMLElement[] = [];
  let last = '';
  const measure = (): void => {
    const { top, bottom } = obscuredInsets(
      bars.map((el) => ({ edge: el.getAttribute(OBSCURES_ATTRIBUTE), height: el.getBoundingClientRect().height })),
    );
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
  observeBars();

  // Browsers do not use scroll-padding when keyboard focus moves to a control that is already inside the viewport, so a
  // control under the dock stays there (Chromium, look gate on /trade/calendar at 200% text). Scroll it clear here.
  const clearFocus = (event: FocusEvent): void => {
    const el = event.target;
    if (!(el instanceof Element) || bars.length === 0 || el.closest(`[${OBSCURES_ATTRIBUTE}]`)) return;
    // Keyboard focus only (WCAG 2.4.11): a pointer press that focuses a control must not move the page under the pointer,
    // or a drag that starts on it lands somewhere else (J-charts-desk-06 #4 drags on the chart after picking a tool).
    if (!focusIsVisible(el)) return;
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
    root.ownerDocument.removeEventListener('focusin', clearFocus);
    mutations.disconnect();
    resize.disconnect();
    root.style.removeProperty(OBSCURED_TOP_VAR);
    root.style.removeProperty(OBSCURED_BOTTOM_VAR);
  };
}

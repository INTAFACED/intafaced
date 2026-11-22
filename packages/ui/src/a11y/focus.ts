/**
 * Focus not obscured (WCAG 2.2 SC 2.4.11). The fixed risk band, the top bar and the phone dock cover
 * part of the page; a control that takes focus under them must scroll clear. a11y.css turns the heights
 * below into scroll-padding, which browsers use when they scroll a focused element into view.
 *
 * A fixed bar says which edge it covers with `data-obscures="top"` or `data-obscures="bottom"`. Their
 * real heights are measured, not assumed, because the risk band grows with text size (200% text must
 * not hide the field under it), and so is the gap between a floating fixed bar and its edge.
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

/**
 * A fixed bar that floats off its edge (the phone dock sits 0.875rem above the screen's bottom) still hides the page
 * from the edge to its far side, so the gap between the edge and the outermost fixed bar counts too. A bar that is not
 * fixed, or not drawn, adds no gap.
 */
function edgeGap(bars: readonly { el: HTMLElement; edge: string | null; rect: DOMRect }[], edge: 'top' | 'bottom'): number {
  const view = bars[0]?.el.ownerDocument.defaultView;
  if (!view) return 0;
  const gaps = bars
    .filter((bar) => bar.edge === edge && bar.rect.height > 0)
    .map(({ el, rect }) =>
      view.getComputedStyle(el).position === 'fixed' ? Math.max(0, edge === 'top' ? rect.top : view.innerHeight - rect.bottom) : 0,
    );
  return gaps.length ? Math.min(...gaps) : 0;
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
    const measured = bars.map((el) => ({ el, edge: el.getAttribute(OBSCURES_ATTRIBUTE), rect: el.getBoundingClientRect() }));
    const stacked = obscuredInsets(measured.map(({ edge, rect }) => ({ edge, height: rect.height })));
    const top = stacked.top + edgeGap(measured, 'top');
    const bottom = stacked.bottom + edgeGap(measured, 'bottom');
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

  return () => {
    mutations.disconnect();
    resize.disconnect();
    root.style.removeProperty(OBSCURED_TOP_VAR);
    root.style.removeProperty(OBSCURED_BOTTOM_VAR);
  };
}

/**
 * Focus not obscured (WCAG 2.2 SC 2.4.11). The fixed risk band, the top bar and the phone dock cover
 * part of the page; a control that takes focus under them must scroll clear. a11y.css turns the heights
 * below into scroll-padding, which browsers use when they scroll a focused element into view.
 *
 * A fixed bar says which edge it covers with `data-obscures="top"` or `data-obscures="bottom"`. Their
 * real heights are measured, not assumed, because the risk band grows with text size (200% text must
 * not hide the field under it). A bottom bar counts from the screen's foot to its top edge, not just its
 * own height: the phone dock floats 0.875rem above the foot, and a control scrolled into that gap still
 * sits behind the pill. Top bars stack flush from the top (one is sticky), so they count their heights.
 */

export const OBSCURES_ATTRIBUTE = 'data-obscures';
export const OBSCURED_TOP_VAR = '--a11y-obscured-top';
export const OBSCURED_BOTTOM_VAR = '--a11y-obscured-bottom';

export interface Bar {
  readonly edge: string | null;
  /** The bar's height; for a bottom bar, the distance from the screen's foot to its top edge (`bottomReach`). */
  readonly height: number;
}

/** How far a bottom bar reaches up from the foot of a viewport `viewport` tall: its height plus any gap under it. */
export function bottomReach(box: { top: number; height: number }, viewport: number): number {
  if (!(box.height > 0)) return 0;
  return Math.min(Math.max(viewport - box.top, box.height), viewport);
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
 * Keep the two custom properties on `root` equal to the bars' real heights, as bars come, go and
 * resize. Returns the function that stops it. Does nothing where there is no DOM.
 */
export function trackObscuringBars(root: HTMLElement = document.documentElement): () => void {
  if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return () => {};

  let bars: HTMLElement[] = [];
  let last = '';
  const measure = (): void => {
    const { top, bottom } = obscuredInsets(
      bars.map((el) => {
        const edge = el.getAttribute(OBSCURES_ATTRIBUTE);
        const box = el.getBoundingClientRect();
        return { edge, height: edge === 'bottom' ? bottomReach(box, window.innerHeight) : box.height };
      }),
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
  // A bottom bar's reach moves with the screen's height (a phone turned, a keyboard shown), not only with its own size.
  window.addEventListener('resize', measure);

  return () => {
    window.removeEventListener('resize', measure);
    mutations.disconnect();
    resize.disconnect();
    root.style.removeProperty(OBSCURED_TOP_VAR);
    root.style.removeProperty(OBSCURED_BOTTOM_VAR);
  };
}

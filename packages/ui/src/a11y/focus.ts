/**
 * Focus not obscured (WCAG 2.2 SC 2.4.11). The fixed risk band, the top bar and the phone dock cover
 * part of the page; a control that takes focus under them must scroll clear. a11y.css turns the heights
 * below into scroll-padding, which browsers use when they scroll a focused element into view.
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

  return () => {
    window.removeEventListener('resize', measure);
    mutations.disconnect();
    resize.disconnect();
    root.style.removeProperty(OBSCURED_TOP_VAR);
    root.style.removeProperty(OBSCURED_BOTTOM_VAR);
  };
}

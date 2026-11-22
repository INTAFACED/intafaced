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
  /** How far the bar floats off its edge (the phone dock sits above the screen's bottom); the gap is covered too. */
  readonly offset?: number;
}

const size = (n: number | undefined): number => (n !== undefined && Number.isFinite(n) && n > 0 ? n : 0);

/** The space covered at each edge: bars stack, so their heights add up, plus the widest gap a floating bar leaves. */
export function obscuredInsets(bars: Iterable<Bar>): { top: number; bottom: number } {
  let top = 0;
  let bottom = 0;
  let topGap = 0;
  let bottomGap = 0;
  for (const bar of bars) {
    const height = size(bar.height);
    if (bar.edge === 'top') {
      top += height;
      topGap = Math.max(topGap, size(bar.offset));
    } else if (bar.edge === 'bottom') {
      bottom += height;
      bottomGap = Math.max(bottomGap, size(bar.offset));
    }
  }
  return { top: top + topGap, bottom: bottom + bottomGap };
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
        const rect = el.getBoundingClientRect();
        // A bar that floats off its edge hides the gap under it as well: a control scrolled to the padding's end
        // must clear the bar's far side, not just its height.
        const offset = edge === 'top' ? rect.top : edge === 'bottom' ? window.innerHeight - rect.bottom : 0;
        return { edge, height: rect.height, offset };
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

  return () => {
    mutations.disconnect();
    resize.disconnect();
    root.style.removeProperty(OBSCURED_TOP_VAR);
    root.style.removeProperty(OBSCURED_BOTTOM_VAR);
  };
}

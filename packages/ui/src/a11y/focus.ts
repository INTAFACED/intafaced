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

  const measure = (): void => {
    const bars = Array.from(root.querySelectorAll<HTMLElement>(`[${OBSCURES_ATTRIBUTE}]`), (el) => ({
      edge: el.getAttribute(OBSCURES_ATTRIBUTE),
      height: el.getBoundingClientRect().height,
    }));
    const { top, bottom } = obscuredInsets(bars);
    root.style.setProperty(OBSCURED_TOP_VAR, `${top}px`);
    root.style.setProperty(OBSCURED_BOTTOM_VAR, `${bottom}px`);
  };

  const resize = new ResizeObserver(measure);
  const observeBars = (): void => {
    resize.disconnect();
    for (const el of root.querySelectorAll(`[${OBSCURES_ATTRIBUTE}]`)) resize.observe(el);
    measure();
  };
  const mutations = new MutationObserver(observeBars);
  mutations.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: [OBSCURES_ATTRIBUTE] });
  observeBars();

  return () => {
    mutations.disconnect();
    resize.disconnect();
    root.style.removeProperty(OBSCURED_TOP_VAR);
    root.style.removeProperty(OBSCURED_BOTTOM_VAR);
  };
}

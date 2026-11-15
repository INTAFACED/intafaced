/**
 * Chart UI options per desk (charts-desk-embed-feed-ops-018, J-charts-desk-07 #6): a typed map of which chart parts are on,
 * set by the route's own screen, never read from a remote list. The chart workbench (`/charts/:symbol`) is the full
 * chart; the spot desk's chart panel (`/trade/spot/:pair`) is the compact one beside the order ticket.
 *
 * A template applied on a desk gives only the parts that desk turns on: a style the desk does not draw keeps the desk's
 * own style, and studies are applied only where the desk draws studies.
 */
import { CHART_STYLES, type ChartStyle } from './chart-style';

export interface ChartFeatureset {
  /** The styles the desk's style control offers and draws. */
  readonly styles: readonly ChartStyle[];
  /** Indicators: the dialog, the legend rows and their panes. */
  readonly studies: boolean;
  /** The drawing tools and the object tree. */
  readonly drawings: boolean;
  /** Save and apply chart templates. */
  readonly templates: boolean;
}

export const CHART_DESKS = ['workbench', 'spot-desk'] as const;
export type ChartDesk = (typeof CHART_DESKS)[number];

export const FEATURESETS: Readonly<Record<ChartDesk, ChartFeatureset>> = {
  workbench: { styles: CHART_STYLES, studies: true, drawings: true, templates: true },
  'spot-desk': { styles: ['candles', 'line'], studies: false, drawings: false, templates: false },
};

/** The parts a desk turns on, as one attribute value ("styles=candles,line studies=off …") a person or a test can read. */
export function describeFeatureset(set: ChartFeatureset): string {
  const on = (value: boolean) => (value ? 'on' : 'off');
  return `styles=${set.styles.join(',')} studies=${on(set.studies)} drawings=${on(set.drawings)} templates=${on(set.templates)}`;
}

/** The style a template gives this desk: the template's when the desk draws it, otherwise the desk keeps its own. */
export const styleOnDesk = (set: ChartFeatureset, wanted: ChartStyle, current: ChartStyle): ChartStyle =>
  set.styles.includes(wanted) ? wanted : current;

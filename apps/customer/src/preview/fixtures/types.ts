import type { PreviewProductId } from '../products';

/**
 * What every fixture file exports (see ../README.md). A fixture is SAMPLE data for one Preview product: invented, labelled,
 * and never read from or written to the API client or the data layer. Amounts are decimal STRINGS (never floats), and
 * every number a screen draws from a fixture is shown next to the Preview caption.
 */
export interface PreviewFixture<Rows> {
  readonly product: PreviewProductId;
  /** Always true. Real data never carries it; a screen can assert it before drawing. */
  readonly sample: true;
  /** One plain-English line saying what the sample shows. */
  readonly note: string;
  readonly rows: Rows;
}

export function definePreviewFixture<Rows>(product: PreviewProductId, note: string, rows: Rows): PreviewFixture<Rows> {
  return Object.freeze({ product, sample: true as const, note, rows });
}

/** A labelled sample row of the common shape (label, value, detail), for stubs and simple lists. */
export interface SampleLine {
  readonly label: string;
  /** Already a display string with its unit ("$1,250.00", "4.20%", "10x"). Money is built from decimal strings, never floats. */
  readonly value: string;
  readonly detail?: string;
}

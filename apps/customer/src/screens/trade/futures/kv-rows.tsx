import { asOfIso, formatAsOf } from '@intafaced/ui/lit';
import type { KeyValueRow } from '@intafaced/ui/lit/templates';
import { UNKNOWN } from '../../../data/format';

type AsOf = Parameters<typeof asOfIso>[0];

export interface KvItem {
  label: string;
  value: string | null | undefined;
  /** IDs and references: left-to-right in the mono face. */
  mono?: boolean;
  /** A line under the value: why it is blank, where it came from. */
  hint?: string;
  /** Stable key when two lines share a label. */
  key?: string;
  /** When this value was read; drawn small after it as "as of 14:03:07". */
  asOf?: AsOf;
}

/**
 * Label and value lines for the kit's KeyValue; a value not known draws the dash, spoken as `unknownLabel`, never 0.
 * A value read at a known time says so after it, in `asOfLabel`'s words.
 */
export function kvRows(
  items: readonly KvItem[],
  unknownLabel = 'unknown',
  { asOfLabel = 'as of', timeZone, now }: { asOfLabel?: string; timeZone?: string; now?: number } = {},
): KeyValueRow[] {
  return items.map(({ label, value, mono, asOf, hint }) => {
    const iso = asOfIso(asOf);
    const shown = iso ? formatAsOf(asOf, { timeZone, now }) : null;
    return {
      label,
      ltr: mono || undefined,
      note: hint,
      value: (
        <>
          {value == null ? (
            <>
              <span aria-hidden="true">{UNKNOWN}</span>
              <span className="lt-sr">{unknownLabel}</span>
            </>
          ) : (
            value
          )}
          {iso && shown ? (
            <span className="lt-kv-note">
              {' '}
              {asOfLabel} <time dateTime={iso}>{shown}</time>
            </span>
          ) : null}
        </>
      ),
    };
  });
}

import type { KeyValueRow } from '@intafaced/ui/lit/templates';
import { UNKNOWN } from '../../../data/format';

/** Label and value lines for the kit's KeyValue; a value not known draws the dash, spoken as `unknownLabel`, never 0. */
export function kvRows(items: readonly { label: string; value: string | null | undefined }[], unknownLabel = 'unknown'): KeyValueRow[] {
  return items.map(({ label, value }) => ({
    label,
    value:
      value == null ? (
        <>
          <span aria-hidden="true">{UNKNOWN}</span>
          <span className="lt-sr">{unknownLabel}</span>
        </>
      ) : (
        value
      ),
  }));
}

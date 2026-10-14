import { moneyCopy } from './copy';
import { dec, fmtPct, SCALE, times, toFixedString } from './deps';
import type { MoneyRow } from './portfolio-source';

/** The five biggest coins get their own colour; everything else is "Other". */
const OWN_COLOURS = 5;

interface Slice {
  key: string;
  label: string;
  /** Ratio string ("0.5912"). */
  share: string;
}

/** Slices of the counted total, biggest first, from decimal strings (no floats). */
export function slicesOf(rows: readonly MoneyRow[], otherLabel: string): Slice[] {
  const sized = rows.flatMap((row) => {
    const share = dec(row.share);
    return share !== null && share > 0n ? [{ row, share }] : [];
  });
  sized.sort((a, b) => (a.share === b.share ? a.row.asset.localeCompare(b.row.asset) : a.share > b.share ? -1 : 1));
  const own: Slice[] = sized.slice(0, OWN_COLOURS).map(({ row }) => ({ key: row.asset, label: row.asset, share: row.share! }));
  const rest = sized.slice(OWN_COLOURS);
  if (rest.length === 0) return own;
  const sum = rest.reduce((total, { share }) => total + share, 0n);
  return [...own, { key: '__other', label: otherLabel, share: toFixedString(sum, 18) }];
}

/** Bar-width weight: the share as a percent with two decimals, built from the decimal string. */
function weight(share: string): string {
  const parsed = dec(share) ?? 0n;
  return toFixedString(times(parsed, 100n * SCALE), 2);
}

/** "32.85%", or "<0.01%" for a coin that is held but too small to round to anything. */
function pctText(share: string): string {
  const parsed = dec(share) ?? 0n;
  const text = fmtPct(share, { signed: false });
  return parsed > 0n && text === '0.00%' ? '<0.01%' : text;
}

/**
 * Allocation bar (UI-SPEC 5.3): 8 px, one segment per coin by share, a legend under it, and the same numbers as a
 * table for screen readers. Widths come from the decimal share strings; nothing is turned into a float.
 */
export function AllocationBar({ rows }: { rows: readonly MoneyRow[] }) {
  const { t } = moneyCopy.useCopy();
  const slices = slicesOf(rows, t('Other'));
  if (slices.length === 0) return null;
  return (
    <section className="money-alloc" aria-label={t('Where your money is')}>
      <div className="money-alloc__bar" aria-hidden="true">
        {slices.map((slice, index) => (
          <span
            key={slice.key}
            className="money-alloc__seg"
            style={{ flexGrow: weight(slice.share), background: `var(--if-alloc-${index + 1})` }}
          />
        ))}
      </div>
      <ul className="money-alloc__legend" aria-hidden="true">
        {slices.map((slice, index) => (
          <li key={slice.key}>
            <span className="money-alloc__dot" style={{ background: `var(--if-alloc-${index + 1})` }} />
            <span>{slice.label}</span>
            <span className="money-alloc__pct">{pctText(slice.share)}</span>
          </li>
        ))}
      </ul>
      <table className="if-sr">
        <caption>{t('Share of your total')}</caption>
        <tbody>
          {slices.map((slice) => (
            <tr key={slice.key}>
              <th scope="row">{slice.label}</th>
              <td>{pctText(slice.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

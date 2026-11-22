import { useState } from 'react';
import { Segmented } from '@intafaced/ui/lit';
import { Shares } from '@intafaced/ui/lit/templates';
import { groupSlices, useAllocation, type AllocationGrouping } from './allocation-source';
import { moneyCopy } from './copy';
import { dec, fmtPct, toFixedString } from './deps';
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

/** "32.85%", or "<0.01%" for a coin that is held but too small to round to anything. */
function pctText(share: string): string {
  const parsed = dec(share) ?? 0n;
  const text = fmtPct(share, { signed: false });
  return parsed > 0n && text === '0.00%' ? '<0.01%' : text;
}

type Grouping = 'coin' | AllocationGrouping;
const GROUPINGS: readonly Grouping[] = ['coin', 'class', 'type'];

/**
 * Allocation (UI-SPEC 5.3): the kit's share bar, one part per group by share, the same shares as a list under it, and as a
 * table for screen readers. By coin comes from the rows on screen; by class and by type come from the bank's own grouping
 * (`bank.portfolio.allocation`), so they add up to the same total. Shares stay decimal strings; the kit turns them into
 * widths only to draw. When the bank cannot give a grouping the switch stays and the screen says why.
 */
export function AllocationBar({ rows }: { rows: readonly MoneyRow[] }) {
  const { t } = moneyCopy.useCopy();
  const [grouping, setGrouping] = useState<Grouping>('coin');
  const server = useAllocation(grouping !== 'coin');
  const coinSlices = slicesOf(rows, t('Other'));
  if (coinSlices.length === 0) return null;

  let slices: Array<{ key: string; label: string; share: string; assets?: string[] }> = coinSlices;
  let note: string | null = null;
  if (grouping !== 'coin') {
    if (server.status === 'ready') {
      const grouped = groupSlices(server.data, grouping);
      if (grouping === 'class' && server.data.classesRefused !== null) note = t('Grouping unavailable');
      else if (grouped === null) note = t('Grouping invalid');
      else slices = grouped.map((slice) => ({ key: slice.key, label: t(slice.labelKey), share: slice.share, assets: slice.assets }));
    } else if (server.status === 'loading') {
      note = t('Grouping loading');
    } else {
      note = t('Grouping unavailable');
    }
  }
  const shown = note === null ? slices : [];
  const unclassified = grouping === 'class' ? (shown.find((slice) => slice.key === 'unclassified')?.assets ?? []) : [];
  const caption =
    grouping === 'coin'
      ? t('Share of your total')
      : grouping === 'class'
        ? t('Share of your total by kind')
        : t('Share of your total by place');

  return (
    <section data-testid="money-alloc" className="lt-stack" aria-label={t('Where your money is')}>
      <Segmented
        label={t('Group by')}
        value={grouping}
        onChange={setGrouping}
        options={GROUPINGS.map((option) => ({
          value: option,
          label: option === 'coin' ? t('Coin') : option === 'class' ? t('Kind') : t('Place'),
        }))}
      />
      {note !== null ? (
        <p className="lt-hint" role="status">
          {note}
        </p>
      ) : (
        <>
          <div data-testid="money-alloc__legend" aria-hidden="true">
            <Shares
              label={caption}
              shares={shown.map((slice) => ({ key: slice.key, label: slice.label, share: slice.share, text: pctText(slice.share) }))}
            />
          </div>
          <div className="lt-sr">
            <table>
              <caption>{caption}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('Group')}</th>
                  <th scope="col">{t('Share')}</th>
                  {grouping === 'class' ? <th scope="col">{t('Coins in it')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {shown.map((slice) => (
                  <tr key={slice.key}>
                    <th scope="row">{slice.label}</th>
                    <td>{pctText(slice.share)}</td>
                    {grouping === 'class' ? <td>{slice.assets?.join(', ')}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unclassified.length > 0 ? (
            <p className="lt-hint">
              {t(unclassified.length === 1 ? 'Unclassified note' : 'Unclassified note many', { assets: unclassified.join(', ') })}
            </p>
          ) : null}
          {grouping !== 'coin' && server.status === 'ready' && server.data.unpriced.length > 0 ? (
            <p className="lt-hint">
              {server.data.unpriced.length === 1 ? t('Asset not counted') : t('Assets not counted', { count: server.data.unpriced.length })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

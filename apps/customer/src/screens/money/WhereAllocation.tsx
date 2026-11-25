import { useMemo, useState } from 'react';
import { Segmented } from '@intafaced/ui/lit';
import { Shares } from '@intafaced/ui/lit/templates';
import { useSupportedAssets } from '../../features/money/supported-assets-reads';
import { moneyCopy } from './copy';
import { dec, fmtPct, toFixedString } from './deps';
import type { Standing } from './standing';
import { allocateStanding, type WhereAllocationClass, type WhereAllocationType } from './where-allocation';
import type { VenueRow } from './where-it-sits';

const OWN_COLOURS = 5;

type Grouping = 'coin' | 'class' | 'type';
const GROUPINGS: readonly Grouping[] = ['coin', 'class', 'type'];

const CLASS_LABEL: Record<WhereAllocationClass, 'Cash' | 'Dollar coins' | 'Other crypto' | 'Commodities' | 'Earn' | 'Unclassified'> = {
  fiat: 'Cash',
  stablecoin: 'Dollar coins',
  crypto: 'Other crypto',
  commodity: 'Commodities',
  earn: 'Earn',
  unclassified: 'Unclassified',
};

const TYPE_LABEL: Record<WhereAllocationType, 'Spendable' | 'Locked'> = {
  available: 'Spendable',
  locked: 'Locked',
};

function pctText(share: string): string {
  const parsed = dec(share) ?? 0n;
  const text = fmtPct(share, { signed: false });
  return parsed > 0n && text === '0.00%' ? '<0.01%' : text;
}

interface ShownSlice {
  key: string;
  label: string;
  valueUsd: string;
  share: string;
  assets?: string[];
}

/**
 * Allocation on the launch model (J-portfolio-06 #1): the kit's share bar and screen-reader table grouped by coin,
 * kind (class) and place (available / locked), computed from the same valued sources as `StandingTotal` so every
 * grouping adds up to the total exactly. Mounted only while at least one holding has a published price.
 */
export function WhereAllocation({ standing, venueRows }: { standing: Standing; venueRows: readonly VenueRow[] }) {
  const { t } = moneyCopy.useCopy();
  const [grouping, setGrouping] = useState<Grouping>('coin');
  const supported = useSupportedAssets();

  const kinds = useMemo<ReadonlyMap<string, string> | null>(() => {
    if (supported.resource.status !== 'ready') return null;
    return new Map(supported.resource.data.assets.map((a) => [a.assetId.toUpperCase(), a.kind]));
  }, [supported.resource]);

  const alloc = useMemo(() => allocateStanding(standing, venueRows, kinds), [standing, venueRows, kinds]);
  if (alloc.coins.length === 0) return null;

  const coinSlices: ShownSlice[] = (() => {
    const own = alloc.coins.slice(0, OWN_COLOURS).map((c) => ({
      key: c.asset,
      label: c.asset,
      valueUsd: c.valueUsd,
      share: c.share,
    }));
    const rest = alloc.coins.slice(OWN_COLOURS);
    if (rest.length === 0) return own;
    const shareSum = rest.reduce((acc, c) => acc + (dec(c.share) ?? 0n), 0n);
    const valueSum = rest.reduce((acc, c) => acc + (dec(c.valueUsd) ?? 0n), 0n);
    return [...own, { key: '__other', label: t('Other'), valueUsd: toFixedString(valueSum, 18), share: toFixedString(shareSum, 18) }];
  })();

  let slices: ShownSlice[] = coinSlices;
  let note: string | null = null;
  if (grouping === 'class') {
    if (supported.resource.status === 'loading') {
      note = t('Grouping loading');
    } else if (supported.resource.status !== 'ready' || alloc.classesRefused !== null) {
      note = t('Grouping unavailable');
    } else {
      slices = alloc.classes
        .filter((row) => (dec(row.share) ?? 0n) > 0n)
        .sort((a, b) => {
          const sa = dec(a.share) ?? 0n;
          const sb = dec(b.share) ?? 0n;
          return sa === sb ? a.class.localeCompare(b.class) : sa > sb ? -1 : 1;
        })
        .map((row) => ({
          key: row.class,
          label: t(CLASS_LABEL[row.class]),
          valueUsd: row.valueUsd,
          share: row.share,
          assets: row.assets.map((m) => m.asset),
        }));
    }
  } else if (grouping === 'type') {
    slices = alloc.types
      .filter((row) => (dec(row.share) ?? 0n) > 0n)
      .sort((a, b) => {
        const sa = dec(a.share) ?? 0n;
        const sb = dec(b.share) ?? 0n;
        return sa === sb ? a.type.localeCompare(b.type) : sa > sb ? -1 : 1;
      })
      .map((row) => ({
        key: row.type,
        label: t(TYPE_LABEL[row.type]),
        valueUsd: row.valueUsd,
        share: row.share,
      }));
  }

  const shown = note === null ? slices : [];
  const unclassified = grouping === 'class' ? (shown.find((slice) => slice.key === 'unclassified')?.assets ?? []) : [];
  const caption =
    grouping === 'coin'
      ? t('Share of your total')
      : grouping === 'class'
        ? t('Share of your total by kind')
        : t('Share of your total by place');

  const control = (
    <Segmented
      label={t('Group by')}
      value={grouping}
      onChange={setGrouping}
      options={GROUPINGS.map((option) => ({
        value: option,
        label: option === 'coin' ? t('Coin') : option === 'class' ? t('Kind') : t('Place'),
      }))}
    />
  );

  // Owner's pick A: one thin bar, its legend on one line, and the grouping control at the line's end. Coin is the face;
  // Kind and Place stay one press away (J-portfolio-06 #1).
  return (
    <section
      data-testid="money-alloc"
      data-total-usd={alloc.totalValueUsd}
      className="money-where__alloc"
      aria-label={t('Where your money is')}
    >
      {note !== null ? (
        <p className="lt-hint money-where__alloc-note" role="status">
          {note}
        </p>
      ) : (
        <>
          <div data-testid="money-alloc__legend" className="money-where__alloc-legend" aria-hidden="true">
            <Shares
              label={caption}
              shares={shown.map((slice) => ({ key: slice.key, label: slice.label, share: slice.share, text: pctText(slice.share) }))}
            />
          </div>
          <div className="lt-sr">
            <table>
              <caption className="lt-sr">{caption}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('Group')}</th>
                  <th scope="col">{t('Share')}</th>
                  {grouping === 'class' ? <th scope="col">{t('Coins in it')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {shown.map((slice) => (
                  <tr key={slice.key} data-group-row={slice.key} data-value-usd={slice.valueUsd} data-share={slice.share}>
                    <th scope="row">{slice.label}</th>
                    <td>{pctText(slice.share)}</td>
                    {grouping === 'class' ? <td>{slice.assets?.join(', ')}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="money-where__alloc-end">
        {unclassified.length > 0 ? (
          <p className="lt-hint">
            {t(unclassified.length === 1 ? 'Unclassified note' : 'Unclassified note many', { assets: unclassified.join(', ') })}
          </p>
        ) : null}
        {note === null && alloc.unpriced.length > 0 ? (
          <p className="lt-hint">
            {alloc.unpriced.length === 1 ? t('Asset not counted') : t('Assets not counted', { count: alloc.unpriced.length })}
          </p>
        ) : null}
        {control}
      </div>
    </section>
  );
}

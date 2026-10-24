import { useMemo, useState } from 'react';
import { moneyCopy } from './copy';
import { Amount, Skeleton, StateBlock, dec, fmtAmount, fmtUsd, refusalCopy } from './deps';
import { CHANGE_RANGES, useHoldingsChange, type BankHoldingsChange, type ChangeRangeKey } from './holdings-change-source';
import { stamp } from './time';
import { usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

const RANGE_COPY: Record<ChangeRangeKey, 'Change 24h' | 'Change 7d' | 'Change 30d'> = {
  '24h': 'Change 24h',
  '7d': 'Change 7d',
  '30d': 'Change 30d',
};

/** "+0.5 BTC", "−100 USDT", "0 USDT": the change in the coin's own unit, signed. */
function signedAmount(change: string, asset: string): string {
  const value = dec(change) ?? 0n;
  const abs = change.startsWith('-') ? change.slice(1) : change;
  return `${value > 0n ? '+' : value < 0n ? '−' : ''}${fmtAmount(abs)} ${asset}`;
}

/**
 * Holdings change over a period (PF-balances-02, J-portfolio-06 #3): for each coin, what was held at the start of the range
 * and now, what rose and what fell, and its value at both ends. A start with nothing held says so; an end with no price
 * says "not priced", never zero.
 */
export function HoldingsChange({ hidden }: { hidden: boolean }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { timeZone } = usePreferences();
  const [key, setKey] = useState<ChangeRangeKey>('7d');
  // Read the clock only when the range changes, so the start stays put while the page is open.
  const from = useMemo(() => {
    const hours = CHANGE_RANGES.find((range) => range.key === key)!.hours;
    return new Date(Date.now() - hours * 3_600_000).toISOString();
  }, [key]);
  const result = useHoldingsChange(from);

  let body;
  if (result.status === 'loading') body = <Skeleton width="100%" height={96} className="bg-field" />;
  else if (result.status === 'error')
    body = (
      <StateBlock kind="error" className="money-state" title={t('Change unreadable')} onRetry={result.retry} retryLabel={t('Try again')} />
    );
  else if (result.status === 'refused') {
    const words = refusalCopy(result.code);
    body = (
      <p className="money-note" data-refused={result.code}>
        {words.title}. {words.body ?? ''} {words.reference ?? ''}
      </p>
    );
  } else if (result.status === 'empty' || result.data.rows.length === 0) body = <p className="money-note">{t('Change nothing held')}</p>;
  else body = <ChangeTable data={result.data} hidden={hidden} copy={copy} timeZone={timeZone} />;

  return (
    <section className="money-card" aria-label={t('Holdings change')}>
      <header className="money-card__head">
        <h2>{t('Holdings change')}</h2>
      </header>
      <div className="money-alloc__switch" role="group" aria-label={t('Change range')}>
        {CHANGE_RANGES.map((range) => (
          <button
            key={range.key}
            type="button"
            className="money-alloc__opt"
            aria-pressed={key === range.key}
            onClick={() => setKey(range.key)}
          >
            {t(RANGE_COPY[range.key])}
          </button>
        ))}
      </div>
      {body}
      <p className="money-note">{t('Holdings change rule')}</p>
    </section>
  );
}

function ChangeTable({
  data,
  hidden,
  copy,
  timeZone,
}: {
  data: BankHoldingsChange;
  hidden: boolean;
  copy: Copy;
  timeZone: Parameters<typeof stamp>[1];
}) {
  const { t } = copy;
  return (
    <table
      className="money-table"
      aria-label={t('Holdings change table', { from: stamp(data.from, timeZone), to: stamp(data.to, timeZone) })}
    >
      <thead>
        <tr>
          <th scope="col">{t('Coin')}</th>
          <th scope="col" className="money-num">
            {t('Change then')}
          </th>
          <th scope="col" className="money-num">
            {t('Change now')}
          </th>
          <th scope="col" className="money-num">
            {t('Change amount')}
          </th>
          <th scope="col" className="money-num">
            {t('Change value then')}
          </th>
          <th scope="col" className="money-num">
            {t('Change value now')}
          </th>
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row) => {
          const none = (dec(row.startAmount) ?? 0n) === 0n;
          return (
            <tr
              key={row.assetId}
              data-change-asset={row.assetId}
              data-start={row.startAmount}
              data-end={row.endAmount}
              data-change={row.change}
            >
              <th scope="row">{row.assetId}</th>
              <td className="money-num">
                {none ? t('No holding yet') : <Amount value={`${fmtAmount(row.startAmount)} ${row.assetId}`} hidden={hidden} />}
              </td>
              <td className="money-num">
                <Amount value={`${fmtAmount(row.endAmount)} ${row.assetId}`} hidden={hidden} />
              </td>
              <td className="money-num">
                <Amount value={signedAmount(row.change, row.assetId)} hidden={hidden} />
              </td>
              <td className="money-num">
                {none ? '—' : row.startValueUsd === null ? t('Not priced') : <Amount value={fmtUsd(row.startValueUsd)} hidden={hidden} />}
              </td>
              <td className="money-num">
                {row.endValueUsd === null ? t('Not priced') : <Amount value={fmtUsd(row.endValueUsd)} hidden={hidden} />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
